---
layout: post
title: "A zero forward value can still have a nonzero gradient"
permalink: /notes/tensorflow-zero-gradient/
categories: [machine-learning, numerical-correctness]
excerpt: "A TensorFlow gradient reused a mask from the forward calculation. At x = 0, the value was right and the derivative was wrong."
---

`xlogy(0, y)` is zero. That does not make its derivative with respect to `x` zero.

That distinction is the core of my [TensorFlow fix, #119869](https://github.com/tensorflow/tensorflow/pull/119869), merged on July 16, 2026. It corrects the gradients of `tf.math.xlogy` and `tf.math.xlog1py` at `x = 0`.

## The value and the slope answer different questions

For a fixed positive `y`, `xlogy(x, y)` is the linear function `x * log(y)`. Its value at `x = 0` is zero, but its slope there is `log(y)`.

Take `y = 3.1`. The value is zero at the origin, while the derivative is about `1.1314`. Moving `x` a small amount changes the result immediately. Returning a zero gradient would tell an optimizer that the function is flat at that point.

The same reasoning applies to `xlog1py(x, y) = x * log1p(y)` for `y > -1`: its derivative with respect to `x` is `log1p(y)`.

## How the forward mask reached the gradient

The old gradient code created a mask indicating whether `x` was nonzero. It then computed the partial derivative with respect to `x` using `xlogy(mask, y)` or `xlog1py(mask, y)`.

When `x` was nonzero, the mask was one and the result matched the expected logarithm. At `x = 0`, the mask became zero and erased the slope.

The forward operation has a useful special case: it returns zero when `x` is zero. Reusing that special case inside the derivative silently changed the mathematics. A branch that produces the desired function value does not necessarily produce the desired derivative.

The patch computes the partial derivatives directly:

| Operation | Partial with respect to `x` |
| :--- | :--- |
| `xlogy(x, y)` | `log(y)` |
| `xlog1py(x, y)` | `log1p(y)` |

It keeps the existing partial derivatives with respect to `y` and the existing broadcast reduction logic. The change is confined to the incorrect partial.

## The regression expectations matter as much as the formula

The upstream tests had expected zero for the `x` gradient at zero. Fixing the implementation therefore also required correcting those expectations.

The merged tests exercise `float16`, `float32`, and `float64`. They check the ordinary zero-`x` case and the logarithm boundary: `y = 0` for `xlogy`, and `y = -1` for `xlog1py`. At those boundaries, the implemented `x` gradient is negative infinity, not zero. The positive-domain slope argument above does not assert a finite classical derivative at a singularity.

The tests also retain checks of the `y` gradient. That is useful because a fix to one partial should not accidentally change the other.

A small mathematical sanity check needs no framework:

```python
from math import isclose, log

y = 3.1
h = 1e-6
slope = ((h * log(y)) - (-h * log(y))) / (2 * h)
assert isclose(slope, log(y), rel_tol=1e-12)
```

This illustrates the positive-domain derivative. The framework regression tests in the PR check TensorFlow's implementation and its edge-case behavior.

When reviewing a custom gradient, I now check the branch points explicitly. A forward result can look entirely reasonable while its gradient removes the signal needed to move away from that point.

**Source:** [merged PR and test changes](https://github.com/tensorflow/tensorflow/pull/119869/files).
