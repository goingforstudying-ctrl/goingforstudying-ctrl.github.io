---
layout: post
title: "The source chose your table names"
permalink: /notes/cloudquery-source-table-names/
categories: [security, data-engineering]
excerpt: "CloudQuery's Postgres destination built DDL from names the source plugin picked. Two paths skipped sanitization, and a CockroachDB migration panicked on a nil transaction while I was in there."
---

The table `weird"; drop table users; --` never existed in my database, but for a while CloudQuery's Postgres destination was willing to run it as a statement.

I was reading [issue #23170](https://github.com/cloudquery/cloudquery/issues/23170), which reported SQL injection in the postgresql destination's migration code. The shape of the bug is the kind I like: most of the file was already careful, and the dangerous lines were the exceptions. `migrate.go` builds DDL by hand, and nearly every statement goes through `pgx.Identifier.Sanitize()`. Two didn't:

```go
func (c *Client) dropTable(ctx context.Context, tableName string) error {
    sql := "drop table " + tableName
    ...
}

func (c *Client) addColumn(ctx context.Context, tableName string, column schema.Column) error {
    sql := "alter table " + tableName + " add column " + columnName + " " + columnType
    ...
}
```

Both concatenate the raw table name. `addColumn` had already sanitized the column name one line earlier, which is what made the omission stand out: somebody knew the rule and missed one variable.

## Who picks your table names

In most applications, developers write the table names and this would be a style violation. CloudQuery is an ELT tool: you configure a source plugin (a cloud account, a SaaS API, a vendor's database) and a destination, and the source's schema decides what the destination's tables are called. The strings flowing into that DDL were chosen by whatever you sync from.

The destination also connects with credentials that can create, alter, and drop tables, because running migrations is the whole point. So a hostile or merely weird source schema becomes arbitrary SQL executed with some of the most powerful credentials in the pipeline. You don't have to imagine a malicious API; a compromised source plugin or a vendor that lets end users name resources is enough.

`Sanitize()` closes the hole by doing the boring correct thing: wrap the name in double quotes and double any embedded quotes. `weird"; drop table users; --` turns into `"weird""; drop table users; --"`, one ugly identifier instead of two statements.

## The injection that came back from the catalog

Sweeping the plugin for the same pattern turned up two more spots. The obvious one was the CrateDB upsert in `insert.go`, which built its conflict clause from raw primary key column names:

```go
sb.WriteString(fmt.Sprintf(" on conflict (%s) ", strings.Join(pks, ",")))
```

The plain Postgres path right above it went through a sanitized constraint name; only the CrateDB branch skipped it.

The subtler one was in `migrateToCQID`, the migration that moves a table's primary key onto CloudQuery's `_cq_id` column. It reads the existing constraint name with `getPKName` and then interpolates it:

```go
"ALTER TABLE " + sanitizedTableName + " DROP CONSTRAINT " + sanitizedPKName
```

The variable was called `sanitizedPKName`, but nothing sanitized it. The name was a leftover from an earlier version of the function, and the compiler can't check adjectives. Worse, the constraint name is attacker-influenced in a non-obvious way: Postgres names default primary keys `<table>_pkey`, so a hostile table name comes back out of `information_schema` embedded inside the constraint name. Quoting the table but not the constraint leaves the door open. I pulled both statements into a `cqIDConstraintSQLs` helper so the quoting happens in exactly one place.

## The panic that hid the real error

The same function carried the issue's second bug. CockroachDB can't drop a `NOT NULL` constraint in the transaction that changes the primary key, so `migrateToCQID` commits, then begins a second transaction mid-function:

```go
tx, err = conn.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
```

If that `BeginTx` fails, `tx` is nil and `err` holds the real failure, right up until the deferred cleanup runs `tx.Rollback(ctx)` on a nil interface and panics. The operator sees a panic trace instead of "couldn't begin transaction."

I extracted the commit-or-rollback logic into a `finalizeTx` helper shared by the deferred call and the CockroachDB mid-block, which were already identical. It returns the incoming error untouched when `tx` is nil. Two details fell out of writing it. First, CockroachDB often reports DDL failures at COMMIT, so the mid-block finalizer now surfaces a commit error instead of letting the next `BeginTx` overwrite it, and sets `tx = nil` so the deferred call doesn't re-handle a closed transaction. Second, pgx closes the transaction inside `Commit` even on failure, so `finalizeTx` deliberately doesn't roll back after a failed commit. That rollback would only return `ErrTxClosed` and log noise.

## Proving the SQL, not the database

The tests don't need a live Postgres. A recording `DBPool` mock captures the exact SQL string, and the tests feed in names like `evil"; drop table users; --` and assert the emitted statement is quoted everywhere it must be. For `finalizeTx`, a `fakeTx` embeds a nil `pgx.Tx` and implements only `Commit` and `Rollback`, with table-driven cases for the four paths: nil tx, clean commit, commit failure without rollback, and rollback on a prior error.

What I took from this one: sanitize at the point of interpolation, not the point of naming. A variable called `sanitizedPKName` was the most dangerous line in the file. And in ELT, trust boundaries sit in odd places. The untrusted input isn't an HTTP form; it's the schema of a system you were told to copy.

My [CloudQuery PR #23640](https://github.com/cloudquery/cloudquery/pull/23640) merged on October 30, 2026. [Sanitization, the `finalizeTx` helper, and tests](https://github.com/cloudquery/cloudquery/pull/23640/files).
