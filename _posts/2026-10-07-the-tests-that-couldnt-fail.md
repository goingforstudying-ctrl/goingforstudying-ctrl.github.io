---
layout: post
title: "The tests that couldn't fail"
---

A test suite has one job: it has to be able to fail. The observability stack in NVIDIA's NVCF repo shipped with a test script that, once I actually read it closely, mostly couldn't. Green CI was the default outcome almost no matter what the configuration logic did, and the fixes that made it honest ended up being a rewrite of how the tests look at the world.

Some context. NVCF deploys its observability stack — VictoriaMetrics, the OpenTelemetry collector, Prometheus Operator CRDs, a default-monitors chart — through Helmfile. There's a profile knob with four values (`disabled`, `control`, `compute`, `all`) and, per component, an ownership mode: the stack can `install` something, treat it as `existing` (already in the cluster, don't touch it), or mark it `disabled`. An external metrics backend can authenticate with `none`, `token`, or `mtls`. All of that branches inside one big gotmpl file, and the branch points multiply fast. Issue #513 scoped the work: make the test suite actually cover the decision matrix.

The old suite, `profile-defaults.sh`, was bash plus `grep`. Three patterns in it bothered me, in increasing order of sneakiness.

First, `grep -q` answers "does this string appear at least once." The monitor checks were loops of `grep -q "nvcf-default-monitors-$monitor" $manifests`. If the template ever rendered the same ServiceMonitor twice — same name, duplicate resource, the kind of thing Kubernetes rejects at apply time — grep is perfectly satisfied. It can't count. The test for "this resource exists" and the test for "this resource exists exactly once" were the same test, and only one of them was true.

Second, indentation as a correctness signal. The RBAC check for the collector's Target Allocator was:

```sh
grep -q '^      - secrets$' "$collector_manifests" ||
  fail "Target Allocator RBAC must allow referenced Secret discovery"
```

That's six literal spaces doing semantic work. Reindent the template — a no-op change, YAML doesn't care — and a correct chart fails. Meanwhile `secrets` showing up in the wrong ClusterRole, or under a non-core API group where it doesn't grant what the Target Allocator needs, passes as long as the whitespace lines up. The assertion was about the file's formatting, not the file's meaning.

Third, and my favorite: the release-dependency check parsed helmfile's *debug log* with awk. It ran `helmfile --log-level debug list` and scraped lines matching `rendering result of "..."` to reconstruct the evaluated state, because `show-dag` eagerly fetches placeholder charts and couldn't be used. Any log-format tweak in a helmfile release and the awk pipeline produces empty output, and the follow-up `test -s` is the only thing standing between you and a suite that silently checks nothing.

The rewrite, which landed as [NVCF PR 1528](https://github.com/NVIDIA/nvcf/pull/1528), swaps every one of those for a structural query. The RBAC check now names the exact ClusterRole and the core API group, and whitespace is out of the loop entirely:

```sh
NVCF_TARGET_ALLOCATOR_ROLE="$collector_name-otel" yq -e '
  select(.kind == "ClusterRole" and .metadata.name == strenv(NVCF_TARGET_ALLOCATOR_ROLE)) |
  .rules[] | select(.apiGroups[] == "") | .resources[] | select(. == "secrets")
' "$work_dir/collector-manifests.yaml" >/dev/null ||
  fail "Target Allocator RBAC must allow referenced Secret discovery"
```

I verified the new query the only way that matters: mutated the rendered YAML by hand — deleted the resource, moved it to an unrelated role, changed the API group — and watched it fail each time. Reindented YAML still passes. A test you haven't watched fail is a hypothesis.

For release sets, the fix is almost embarrassing in its simplicity: `helmfile list --output json`, pull names with yq, sort, join into a comma-separated string, and compare the whole string for equality. A duplicated release changes the string, so duplicates finally fail. Same trick for rendered monitor resources — collect `kind/name` pairs from the output directory, sort, join, compare. Dependency edges come from `helmfile build`, which emits the evaluated state as YAML; yq reads `.releases[].needs[]` straight out of it. No more debug-log archaeology.

The piece with the longest tail is the golden fixture. Each profile's expected release names and monitor resources live in a six-line checked-in file:

```
# profile|sorted release names|sorted rendered monitor resources
disabled||
control|default-monitors,opentelemetry-operator,...|ServiceMonitor/nvcf-default-monitors-grpc-proxy,...
```

The scoping is deliberate. The compute-plane stack in the same repo snapshots entire rendered manifests as goldens, and I explicitly didn't do that here: snapshotting third-party chart output means every upstream chart bump produces a hundred-line fixture diff nobody reviews, and the fixture quietly becomes write-only. Six rows of stack-owned names is small enough that a reviewer actually reads the diff when it changes. Regenerating is a conscious act — `make generate-test-golden`, then `git diff` and confirm every changed row was intended.

Around the fixture sits a table of pipe-delimited case rows: ten ownership-mode combinations (CRDs existing, operator existing, collector disabled, backend external, and so on), three authentication modes against an external backend, and three monitor-override swaps where explicit values have to beat profile defaults. Each row asserts the exact release set, the `needs` edges per release, and the resolved values from `helmfile write-values` — things like `targetAllocator.enabled` and the collector's remote-write endpoint.

The check I like most crosses chart boundaries. The function-autoscaler chart owns its Service labels; the default-monitors chart's ServiceMonitor selects on those labels. Neither chart can see the other, so a label rename in the application chart used to surface as "metrics just stop showing up" — no error anywhere, Prometheus just finds nothing. The test now renders both charts, extracts the actual label values from each side, rejects null or missing values first (otherwise two absences compare equal and the test lies again), and asserts they're identical.

Who hits this: platform teams running NVCF who flip a component to `existing` or `disabled` and get a stack that renders cleanly but deploys broken — VictoriaMetrics starting before the CRDs it needs exist, monitors selecting zero Services. Nobody pages you for a test that passed, which is exactly why tests that can't fail are worse than no tests: they convert real misconfigurations into false confidence at the worst moment, the deploy. The general lesson isn't about Helmfile or bash. It's that an assertion is only as strong as the query behind it, and `grep -q` is a query that answers a question nobody asked.
