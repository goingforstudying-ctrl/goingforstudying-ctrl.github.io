---
layout: post
title: "The test was protecting the bug"
permalink: /notes/tensorflow-zero-gradient/
categories: [machine-learning, numerical-correctness]
excerpt: "TensorFlow returned a zero gradient, and an existing test agreed. A straight line through the origin gave me a reason to doubt them both."
---

TensorFlow's gradient test expected zero, and the implementation was happy to oblige. At `x = 0` and `y = 3.1`, `xlogy` also returned a forward value of zero. Everything agreed until you wrote down the slope: `log(3.1)`, about `1.1314`.

That agreement bothered me more than a failing assertion would have. The test was vouching for the bug. Correcting the derivative meant changing an expectation that already looked settled.

## A straight line through zero

Hold `y` at a positive constant. Then `xlogy(x, y)` is just `x * log(y)`, a straight line through the origin. Setting `x` to zero tells you where the line is; it doesn't flatten the line. A small change in `x` still changes the result by `log(y)` times that amount.

This is a useful counterexample because it fits on paper. You can also check it without importing TensorFlow:

```python
from math import isclose, log

y = 3.1
h = 1e-6
slope = ((h * log(y)) - (-h * log(y))) / (2 * h)
assert isclose(slope, log(y), rel_tol=1e-12)
```

The old gradient would tell an optimizer that this function was flat at zero. The two nearby evaluations above give a different answer.

## The shortcut survived into the backward pass

The forward operation deliberately returns zero when `x` is zero. That behavior is useful, and the gradient code borrowed it: build a mask that is one where `x` is nonzero, then evaluate `xlogy(mask, y)` to get the partial derivative with respect to `x`.

I can see the appeal. Away from zero, the mask is one and the expression gives `log(y)`. It reuses an operation whose behavior is already defined. At zero, though, the same operation does exactly what it was designed to do: it returns zero and erases the derivative we needed.

`xlog1py` had the same pattern. For `y > -1`, its expression is `x * log1p(y)`, so its slope with respect to `x` is `log1p(y)` even at `x = 0`.

The fix replaces the masked expressions with those logarithms directly:

| Operation | Partial with respect to `x` |
| :--- | :--- |
| `xlogy(x, y)` | `log(y)` |
| `xlog1py(x, y)` | `log1p(y)` |

The `y` partials and broadcast reductions stay as they were. There was no reason to disturb them to fix this derivative.

## The expectation had to move too

Changing the implementation alone would make the existing zero-`x` tests complain. I changed their expectations to the logarithms and kept the zero expectations for the `y` gradients. That gives the patch a useful boundary: one partial changes, while the other is checked explicitly.

The merged tests cover `float16`, `float32`, and `float64`. They also cover `y = 0` for `xlogy` and `y = -1` for `xlog1py`, where the implemented `x` gradient is negative infinity. Those singularities have no finite classical derivative; the straight-line argument above applies to the positive logarithm domain.

What I wanted from these tests was an expectation with a reason behind it. At `y = 3.1`, that reason is a slope you can calculate independently. At the logarithm boundaries, the tests pin down TensorFlow's behavior explicitly.

My [TensorFlow PR #119869](https://github.com/tensorflow/tensorflow/pull/119869) merged on July 16, 2026. [Implementation and test changes](https://github.com/tensorflow/tensorflow/pull/119869/files).
