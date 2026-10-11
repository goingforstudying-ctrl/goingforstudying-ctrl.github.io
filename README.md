# Engineering notes

Root-cause write-ups on AI infrastructure and distributed systems, published as [goingforstudying-ctrl](https://github.com/goingforstudying-ctrl).

**[Read the site →](https://goingforstudying-ctrl.github.io/)**

## Start here

- [A zero forward value can still have a nonzero gradient](https://goingforstudying-ctrl.github.io/notes/tensorflow-zero-gradient/) — TensorFlow, numerical edge cases, and regression expectations.
- [A cleanup path is still a concurrent caller](https://goingforstudying-ctrl.github.io/notes/celery-pubsub-concurrency/) — Celery, Redis pub/sub ownership, and reentrant locking.
- [A delayed success event can fail a healthy task](https://goingforstudying-ctrl.github.io/notes/airflow-stale-success/) — Airflow, event ordering, and state-machine guards.

Each technical note links to the merged upstream PR. This repository contains the writing and Jekyll source for the site.
