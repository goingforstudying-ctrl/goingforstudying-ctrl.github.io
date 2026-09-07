---
layout: post
title: "The gradient that died at zero"
---

When I read the reproduction in [issue #119476](https://github.com/tensorflow/tensorflow/issues/119476), it looked almost too simple to be real. Compute the gradient of `tf.math.xlogy(x, y)` with respect to `x` at `x = 0`, with `y = 2.0`. TensorFlow returned zero. The same three lines in PyTorch returned `log(2)`, about 0.6931. Two mature frameworks, one scalar answer, and both can't be right. So I dug into TensorFlow's gradient implementations, and the bug turned out to be a forward-pass convention that had quietly leaked into the derivative.

`xlogy(x, y)` computes `x * log(y)`, but with a convention attached: `xlogy(0, y) = 0`. The convention exists so that `0 * log(0)` comes out as zero instead of NaN. It's the standard continuous extension, and it's correct — for the forward value. The trouble starts when the same convention sneaks into the gradient. In `math_grad.py`, the gradient with respect to `x` looked like this:

```python
not_zero_x = math_ops.cast(
    math_ops.not_equal(x, math_ops.cast(0., dtype=x.dtype)), dtype=x.dtype)
partial_x = gen_math_ops.xlogy(not_zero_x, y)
```

The derivative of `x * log(y)` with respect to `x` is `log(y)` — for every `x`, including `x = 0`, because the function is linear in `x`. At `x = 0` the piecewise definition of the forward value has no effect on the slope. But look at what the code actually computes. When `x != 0`, `not_zero_x` is 1, and `xlogy(1, y)` is `log(y)` — fine. When `x = 0`, `not_zero_x` is 0, and `xlogy(0, y)` is pinned to zero by that very convention. The gradient died exactly at the point the convention was meant to protect. The same pattern sat in `_XLog1pyGrad`: `xlog1py(x, y)` is `x * log1p(y)`, its gradient with respect to `x` is `log1p(y)` everywhere, but the implementation fed the mask through `xlog1py` and got zero at `x = 0`.

The fix removes the mask from the derivative entirely:

```python
partial_x = gen_math_ops.log(y)
```

and `gen_math_ops.log1p(y)` in the `xlog1py` case. The zero-mask still applies to the forward value, where it belongs. The derivative is computed directly.

Why this matters: `xlogy` isn't a museum piece. It's the shape you reach for whenever you need an `x * log(...)` term that survives zeros — KL divergence terms, cross-entropy-style losses, mixture models. If a parameter in one of those terms sits at exactly zero, a mixture weight say, the old code reported zero gradient for that term. The optimizer sees nothing to push on, so the parameter can only move through whatever other gradients it receives; the information in that term was silently dropped. The report named it correctly: a dead zone in the optimization landscape. And it's the kind of bug that doesn't crash anything — it just makes models train a little worse, which is precisely why it sat there undetected. Someone had to cross-check against PyTorch to notice.

The fix also changed two edge-case answers, and I think for the better. At `y = 0`, the gradient with respect to `x` is now `log(0) = -inf`; the old code returned a quiet zero. At `y = -1` for `xlog1py`, it's `log1p(-1) = -inf` likewise. Those are the honest answers: the function genuinely drops off a cliff there as `x` moves away from zero, and reporting `-inf` instead of a fabricated zero is the difference between a model seeing a warning sign and a model sitting at a wrong answer with a satisfied zero gradient. The updated tests pin both cases down across float16, float32, and float64.

Verification was straightforward. The reproducer from #119476 now returns gradients matching PyTorch's, and the targeted bazel tests for `XlogyTest` and `Xlog1pyTest` pass. The change itself, [PR #119869](https://github.com/tensorflow/tensorflow/pull/119869), is small — the diagnosis is where the work was. If you train anything that differentiates through `xlogy` or `xlog1py`, or you ported a model from PyTorch and found a gradient discrepancy you couldn't explain, this was likely the bug you were looking at. The two frameworks agree again now.
