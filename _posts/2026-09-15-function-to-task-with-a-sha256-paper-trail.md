---
layout: post
title: "From function to task, with a SHA-256 paper trail"
---

NVCF, NVIDIA's cloud functions platform, runs serverless GPU workloads in two shapes: long-running Functions and run-to-completion Tasks. The docs had solid examples for each shape on its own, but nothing showing them working together as one pipeline, which is exactly what issue #115 asked for. So I built a reference architecture that chains them, and most of the interesting engineering turned out to hang on a single question: when a Task reports that it processed a model, how do you prove what it actually saw?

The flow is straightforward on paper. A Function admits a workflow request and returns artifact references; a Task mounts those artifacts and does the run-to-completion work; the Task's output lands in a shared results location. The piece I spent the most time on is the Task image itself — a Python standard-library container that walks the mounted model and dataset directories and writes a deterministic SHA-256 inventory, report.json, next to the results.

"Deterministic" is doing heavy lifting there. Two runs over the same bytes should produce byte-identical JSON, so the walk sorts directory entries, hashes files in sorted order, and skips the platform's own .nvcf_manifest.json marker. Symlinks are refused outright, and the open path is paranoid in a way that took a while to get right:

```python
open_flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
file_descriptor = os.open(path, open_flags)
digest = hashlib.sha256()
with os.fdopen(file_descriptor, "rb") as artifact_file:
    opened_metadata = os.fstat(artifact_file.fileno())
    if (not stat.S_ISREG(opened_metadata.st_mode)
            or opened_metadata.st_dev != file_metadata.st_dev
            or opened_metadata.st_ino != file_metadata.st_ino):
        raise ValueError("artifact path changed while opening")
    for chunk in iter(lambda: artifact_file.read(1024 * 1024), b""):
        digest.update(chunk)
```

The stat from before the open and the fstat from after have to agree — same device, same inode, still a regular file — otherwise something swapped the path in between and we refuse to hash it. On a shared volume where one artifact directory can be made to point into another, that guard is what keeps the inventory honest. A hash of a file that changed mid-read isn't just useless; it's a false claim about what ran.

The report carries each file's relative path, size, and digest, plus a summary of counts and total bytes. It's written atomically — temp file, then os.replace — and the Task's progress file publishes the report's own SHA-256 next to the 100% complete marker, so whoever reads the report downstream can verify it's the one the Task actually wrote. The inventory also follows the worker-task naming convention, artifact-inventory_<uuid>, so the published result lines up with what existing NGC tooling expects.

The other half of the work was in the CLI. Orchestrating this flow means polling task status, events, and results, and the nvcf-cli commands for that had no concept of a deadline: one hung status read could block your automation forever. The PR adds --timeout to task get, task events, and task results, with independent deadlines for events and results and bounded retries on transient status reads. The tests assert the timeout genuinely cancels the in-flight HTTP request — TestTaskEventsTimeoutCancelsHTTPRequest and its siblings, run under the race detector — rather than just breaking the loop afterwards. Secrets got the same treatment: the NGC write key is written mode-600 instead of being passed through argv, where ps would show it to anyone on the box.

The whole thing is runnable as a unit from a checkout — bash the pipeline's test_run.sh, ten unit tests in the Task image, 21 bazel targets on the CLI side, go test -race clean. The merged PR is https://github.com/NVIDIA/nvcf/pull/457.

The reason to care about an inventory pipeline like this is reproducibility. Model serving teams want to answer "which exact bytes produced this output" weeks after the run, and the answer has to survive retries, shared volumes, and people touching things. A sorted walk and a couple of fstat checks get you most of the way there; the rest is just refusing to hash anything you can't prove you opened.
