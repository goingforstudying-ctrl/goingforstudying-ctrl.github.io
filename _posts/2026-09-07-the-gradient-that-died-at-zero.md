---
layout: post
title: "The gradient that died at zero"
---

When I read the reproduction in [issue #119476](https://github.com/tensorflow/tensorflow/issues/119476), it looked almost too simple to be real. Compute the gradient of `tf.math.xlogy(x, y)` with respect to `x` at `x = 0`, with `y = 2.0`. TensorFlow returned zero. The same three lines in PyTorch returned `log(2)`, about 0.6931. Two mature frameworks, one scalar answer, and both can't be right. So I dug into TensorFlow's gradient implementations, and the bug turned out to be a forward-pass convention that had quietly leaked into the derivative.

`xlogy(x, y)` computes `x * log(y)`, but with a convention attached: `xlogy(0, y) = 0`. The convention exists so that `0 * log(0)` comes out as zero instead of NaN. It is a special-value convention for the forward operation. It is not a joint continuous extension of `x * log(y)` at `(0, 0)`: limits there can depend on the path. The trouble starts when the same convention sneaks into the gradient. In `math_grad.py`, the gradient with respect to `x` looked like this:

```python
not_zero_x = math_ops.cast(
    math_ops.not_equal(x, math_ops.cast(0., dtype=x.dtype)), dtype=x.dtype)
partial_x = gen_math_ops.xlogy(not_zero_x, y)
```

The derivative of `x * log(y)` with respect to `x` is `log(y)` — for every real `x` when `y > 0`, including `x = 0`, because the function is linear in `x` on that domain. At `x = 0` the piecewise definition of the forward value has no effect on the slope. But look at what the code actually computes. When `x != 0`, `not_zero_x` is 1, and `xlogy(1, y)` is `log(y)` — fine. When `x = 0`, `not_zero_x` is 0, and `xlogy(0, y)` is pinned to zero by that very convention. The gradient died exactly at the point the convention was meant to protect. The same pattern sat in `_XLog1pyGrad`: `xlog1py(x, y)` is `x * log1p(y)`, its gradient with respect to `x` is `log1p(y)` when `y > -1`, but the implementation fed the mask through `xlog1py` and got zero at `x = 0`.

The fix removes the mask from the derivative entirely:

```python
partial_x = gen_math_ops.log(y)
```

and `gen_math_ops.log1p(y)` in the `xlog1py` case. The zero-mask still applies to the forward value, where it belongs. The derivative is computed directly.

Why this matters: `xlogy` isn't a museum piece. It's the shape you reach for whenever you need an `x * log(...)` term that survives zeros — KL divergence terms, cross-entropy-style losses, mixture models. If a parameter in one of those terms sits at exactly zero, a mixture weight say, the old code reported zero gradient for that term. The optimizer sees nothing to push on, so the parameter can only move through whatever other gradients it receives; the information in that term was silently dropped. The report named it correctly: a dead zone in the optimization landscape. That can affect optimization relying on this term, but the PR does not provide a training benchmark quantifying the effect.

The formula also changes the special values returned by automatic differentiation. At `y = 0`, `log(y)` returns `-inf`; for `xlog1py` at `y = -1`, `log1p(y)` does the same. These are non-finite results of the implemented gradient formula, not ordinary finite derivatives at those boundary points. Outside the real logarithm domains, NaN and other special-value behavior also need to be considered. The updated tests cover zero inputs and boundary results across float16, float32, and float64.

The updated tests in [PR #119869](https://github.com/tensorflow/tensorflow/pull/119869) pin down the gradient at zero and the boundary values. For the reported positive-domain example, differentiating `xlogy(x, 2)` at zero should give `log(2)`, rather than zero. That conclusion is narrower than claiming that all TensorFlow and PyTorch edge cases agree. The PR merged on July 16, 2026; whether a particular TensorFlow build includes it depends on its version.

Implementation reference: [merged commit](https://github.com/tensorflow/tensorflow/commit/b7721c768c6f0feba9a3b46f8d5569839b046830) (2026-07-16).
