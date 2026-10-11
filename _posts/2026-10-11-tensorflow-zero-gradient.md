---
layout: post
title: "The test was protecting the bug"
permalink: /notes/tensorflow-zero-gradient/
categories: [machine-learning, numerical-correctness]
excerpt: "TensorFlow returned a zero gradient, and an existing test agreed. A straight line through the origin gave me a reason to doubt them both."
---

At `x = 0` and `y = 3.1`, TensorFlow's `xlogy` returned a value of zero and a gradient of zero. The existing test agreed with both. The value was right. The gradient should have been about `1.1314`.

A passing test makes me hesitate in a way a failing one doesn't. Before changing the implementation, I wanted an answer small enough to check without TensorFlow. Fix `y`, draw the function, and ask what happens just to either side of zero. The line goes straight through the origin. Its slope never disappears.

That left two things to change: the backward pass and the test that had been defending it.

## A zero value can still carry a gradient

For positive `y`, `xlogy(x, y)` is `x * log(y)`. Holding `y = 3.1` makes it a straight line with slope `log(3.1)`. Setting `x` to zero picks a point on that line; it doesn't change its slope.

<div class="article-visual article-visual-gradient">
{% include gradient.html %}
</div>

Move the point away from zero and the old gradient agrees with the correct one. Reset it, and the error appears at the origin. This particular bug is easy to miss if a gradient check samples ordinary nonzero inputs.

The numerical check I kept coming back to needs only two nearby evaluations:

```python
from math import isclose, log

y = 3.1
h = 1e-6
slope = ((h * log(y)) - (-h * log(y))) / (2 * h)
assert isclose(slope, log(y), rel_tol=1e-12)
```

This matters in a training graph because the backward pass sends a sensitivity upstream. If the loss contributes an upstream gradient `g`, this operation should return `g * log(y)` with respect to `x`, before any broadcast reduction. Returning zero erases that contribution. A forward-value check can pass while the optimizer receives the wrong signal.

## The forward shortcut leaked into autodiff

The old implementation was compact. It built a mask that was one wherever `x` was nonzero, then used `xlogy(mask, y)` as the partial derivative with respect to `x`.

I can see why that looked reasonable. At a nonzero `x`, the mask becomes one, and `xlogy(1, y)` gives `log(y)`. It also reuses the forward operation's handling of zero. Unfortunately, that is exactly where the derivative gets lost: `xlogy(0, y)` deliberately returns zero.

The forward operation has a special value convention. Reusing it inside the gradient accidentally turned that convention into a statement about local sensitivity. Those are separate decisions, and the derivative only becomes obvious once you write them down separately.

`xlog1py` used the same construction. Inside its logarithm domain, `y > -1`, the function is `x * log1p(y)`, so the slope with respect to `x` is `log1p(y)` at the origin too.

The patch uses the logarithms directly:

| Operation | Partial with respect to `x` |
| :--- | :--- |
| `xlogy(x, y)` | `log(y)` |
| `xlog1py(x, y)` | `log1p(y)` |

The surrounding gradient machinery still multiplies by the upstream gradient, reduces broadcast dimensions, and reshapes the result to the input shape. I left the `y` partials alone. A correction to one derivative shouldn't acquire unrelated changes to broadcasting or the other input's gradient.

## The regression needed an independent answer

Changing the code made the existing zero-`x` expectations wrong. I changed those expectations to the logarithms and kept the checks that the `y` gradients are zero for these inputs. The regression now distinguishes the two partials instead of letting a shared zero hide the difference.

The merged tests exercise `float16`, `float32`, and `float64`. They also cover `y = 0` for `xlogy` and `y = -1` for `xlog1py`, where TensorFlow's implemented `x` gradient is negative infinity. These boundary cases have no finite classical derivative. The straight-line argument above applies inside the logarithm domain; the boundary tests pin down the framework's chosen behavior.

I care about that distinction because a numerical check and an API boundary test answer different questions. At `y = 3.1`, I can derive a finite slope and compare it with nearby values. At the singularity, I need the test to state the intended behavior explicitly.

This patch changed only a few expressions, but it changed what a green test meant to me. When a gradient expectation looks suspicious, I now want a derivation or an independent numerical check beside it. Reproducing the implementation in the expected value can preserve the same mistake for years.

My [TensorFlow PR #119869](https://github.com/tensorflow/tensorflow/pull/119869) merged on July 16, 2026. [Implementation and test changes](https://github.com/tensorflow/tensorflow/pull/119869/files).
