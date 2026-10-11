---
layout: post
title: "A zero forward value can still have a nonzero gradient"
permalink: /notes/tensorflow-zero-gradient/
categories: [machine-learning, numerical-correctness]
excerpt: "A TensorFlow gradient reused a mask from the forward calculation. At x = 0, the value was right and the derivative was wrong."
---

At `x = 0` and `y = 3.1`, TensorFlow's `xlogy` returned the right value: zero. Its gradient with respect to `x` was also zero. That part was wrong; the slope is about `1.1314`.

My [TensorFlow fix, #119869](https://github.com/tensorflow/tensorflow/pull/119869), merged on July 16, 2026, corrects this case for `tf.math.xlogy` and `tf.math.xlog1py`. The implementation reused a forward-pass mask, and the tests had learned to expect its result.

## Where the zero came from

For a fixed positive `y`, `xlogy(x, y)` is the linear function `x * log(y)`. At the origin its value is zero and its slope is `log(y)`. A small change in `x` immediately changes the result. A zero gradient would tell an optimizer that the function is flat there.

Reading the gradient code, I can see why the mask looked useful. The forward operation already needed special handling at zero. Reusing that machinery seems reasonable until you write down the slope.

The old gradient code created a mask indicating whether `x` was nonzero. It computed the partial derivative with respect to `x` using `xlogy(mask, y)` or `xlog1py(mask, y)`.

Away from zero, the mask was one, so this returned the expected logarithm. At zero, the mask erased it. The forward operation deliberately returns zero when `x` is zero; carrying that behavior into the derivative removed a valid slope.

The same reasoning applies to `xlog1py(x, y) = x * log1p(y)` for `y > -1`. Its partial derivative with respect to `x` is `log1p(y)`.

## Changing the partial derivative

I replaced the masked operations with the logarithms directly:

| Operation | Partial with respect to `x` |
| :--- | :--- |
| `xlogy(x, y)` | `log(y)` |
| `xlog1py(x, y)` | `log1p(y)` |

The partial derivatives with respect to `y` and the broadcast reduction logic stay as they were. Only the incorrect partial needed to change.

For the positive-domain case, this small check needs no framework:

```python
from math import isclose, log

y = 3.1
h = 1e-6
slope = ((h * log(y)) - (-h * log(y))) / (2 * h)
assert isclose(slope, log(y), rel_tol=1e-12)
```

## The tests expected the wrong result too

This was the part I wanted to make explicit in the patch: an existing test can preserve the bug just as effectively as the implementation. The zero-`x` expectations had to change with the formula.

The merged tests cover `float16`, `float32`, and `float64`, including the ordinary case above and the logarithm boundaries: `y = 0` for `xlogy`, and `y = -1` for `xlog1py`. At those boundaries, TensorFlow's implemented `x` gradient is negative infinity. There is no finite classical derivative at those singularities; the positive-domain argument does not extend to them.

The tests retain the zero expectations for the `y` gradient. That checks that fixing one partial leaves the other intact. The finite-difference snippet checks the mathematics at a positive `y`; the tests in the PR check TensorFlow's implementation and its boundary behavior.

**Source:** [merged PR and test changes](https://github.com/tensorflow/tensorflow/pull/119869/files).
