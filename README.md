# Engineering notes

Notes on machine learning, AI engineering, and distributed systems, published as [goingforstudying-ctrl](https://github.com/goingforstudying-ctrl).

[Read the site](https://goingforstudying-ctrl.github.io/)

## Start here

- [The test was protecting the bug](https://goingforstudying-ctrl.github.io/notes/tensorflow-zero-gradient/): TensorFlow's implementation and test agreed on a gradient the mathematics couldn't support.
- [The retry skipped the document that failed](https://goingforstudying-ctrl.github.io/notes/swiftide-indexing-cache/): an indexing cache promised completion before the work was done.
- [The socket race started in a destructor](https://goingforstudying-ctrl.github.io/notes/celery-pubsub-concurrency/): following result cleanup into a shared Redis socket, then choosing a lock that won't deadlock in a callback.
- [A late success sent Airflow down the failure path](https://goingforstudying-ctrl.github.io/notes/airflow-stale-success/): a resumed task, an old worker event, and a state guard that stopped one state short.

Each technical note links to the merged upstream PR. This repository contains the writing and Jekyll source for the site.
