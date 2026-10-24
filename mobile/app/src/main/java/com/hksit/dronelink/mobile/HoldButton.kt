package com.hksit.dronelink.mobile

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.util.AttributeSet
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.animation.LinearInterpolator
import android.widget.Toast
import androidx.appcompat.widget.AppCompatTextView
import androidx.core.content.ContextCompat

/**
 * A flight button that only acts after being held for 1.2 seconds, so a
 * stray tap can never start the motors, land or turn the drone around.
 */
class HoldButton @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : AppCompatTextView(context, attrs) {
    var onConfirmed: (() -> Unit)? = null
    var accent: Int = ContextCompat.getColor(context, R.color.accent)
        set(value) { field = value; invalidate() }

    private val holdMs = 1200L
    private var progress = 0f
    private var animator: ValueAnimator? = null
    private val bg = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = ContextCompat.getColor(context, R.color.panel) }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val border = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = resources.displayMetrics.density * 1.5f }
    private val rect = RectF()

    init {
        gravity = Gravity.CENTER
        setTextColor(ContextCompat.getColor(context, R.color.text))
        textSize = 15f
        paint.isFakeBoldText = true
        isClickable = true
    }

    override fun onDraw(canvas: Canvas) {
        val r = resources.displayMetrics.density * 10
        rect.set(0f, 0f, width.toFloat(), height.toFloat())
        canvas.drawRoundRect(rect, r, r, bg)
        if (progress > 0f) {
            fill.color = accent
            fill.alpha = 210
            canvas.save()
            canvas.clipRect(0f, 0f, width * progress, height.toFloat())
            canvas.drawRoundRect(rect, r, r, fill)
            canvas.restore()
        }
        border.color = if (isEnabled) accent else 0x553A4450
        val inset = border.strokeWidth / 2
        rect.inset(inset, inset)
        canvas.drawRoundRect(rect, r, r, border)
        super.onDraw(canvas)
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (!isEnabled) return false
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                parent?.requestDisallowInterceptTouchEvent(true)
                start()
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                if (animator?.isRunning == true) {
                    cancel()
                    if (event.actionMasked == MotionEvent.ACTION_UP) Toast.makeText(context, R.string.hold_hint, Toast.LENGTH_SHORT).show()
                }
            }
        }
        return true
    }

    // Accessibility services click instead of holding; keep it deliberate with a hint
    override fun performClick(): Boolean {
        super.performClick()
        Toast.makeText(context, R.string.hold_hint, Toast.LENGTH_SHORT).show()
        return true
    }

    private fun start() {
        animator?.cancel()
        animator = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = holdMs
            interpolator = LinearInterpolator()
            addUpdateListener {
                progress = it.animatedValue as Float
                invalidate()
            }
            addListener(object : android.animation.AnimatorListenerAdapter() {
                private var cancelled = false
                override fun onAnimationCancel(animation: android.animation.Animator) { cancelled = true }
                override fun onAnimationEnd(animation: android.animation.Animator) {
                    if (cancelled) return
                    performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
                    progress = 0f
                    invalidate()
                    onConfirmed?.invoke()
                }
            })
            start()
        }
    }

    private fun cancel() {
        animator?.cancel()
        progress = 0f
        invalidate()
    }

    override fun setEnabled(enabled: Boolean) {
        super.setEnabled(enabled)
        if (!enabled) cancel()
        alpha = if (enabled) 1f else 0.45f
        invalidate()
    }
}
