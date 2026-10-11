# Engineering notes

Notes on machine learning, AI engineering, and distributed systems, published as [goingforstudying-ctrl](https://github.com/goingforstudying-ctrl).

[Read the site](https://goingforstudying-ctrl.github.io/)

## Start here

- [A zero forward value can still have a nonzero gradient](https://goingforstudying-ctrl.github.io/notes/tensorflow-zero-gradient/): TensorFlow's forward mask and an incorrect test expectation.
- [Caching a document before indexing it can make a failure permanent](https://goingforstudying-ctrl.github.io/notes/swiftide-indexing-cache/): Swiftide's completion tracking across chunks and branches.
- [A cleanup path is still a concurrent caller](https://goingforstudying-ctrl.github.io/notes/celery-pubsub-concurrency/): shared Redis sockets and reentrant locking in Celery.
- [A delayed success event can fail a healthy task](https://goingforstudying-ctrl.github.io/notes/airflow-stale-success/): stale events and the regression that constrains an Airflow state guard.

Each technical note links to the merged upstream PR. This repository contains the writing and Jekyll source for the site.
