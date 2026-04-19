/**
 * ReviewStars component
 *
 * Renders: ★★★★☆ 4.5 (1,458 reviews)
 *
 * Usage:
 *   import ReviewStars from './components/ReviewStars';
 *   <ReviewStars rating={p.r} reviews={p.reviews} />
 *
 * Props:
 *   rating   — 0-5 decimal number (e.g. 4.5, 4.3, 4.8). Handles nulls/undefined gracefully.
 *   reviews  — integer review count. Formatted with commas (1458 → "1,458").
 *   size     — 'sm' (default) or 'md' or 'lg' — scales the whole component.
 *   compact  — if true, renders "★★★★☆ 4.5 (1.5k)" with k-abbreviation for large counts.
 */

import React from 'react';

const STAR_FILLED = '★';
const STAR_EMPTY = '☆';

function buildStars(rating) {
  // Returns an array of 5 { filled: boolean, half: boolean } for rendering.
  // Amazon-style half-star rounding: 4.3 → 4 filled + 1 empty, 4.7 → 5 filled.
  // Half-star appears for values .25 to .75.
  const r = Math.max(0, Math.min(5, rating || 0));
  const stars = [];
  for (let i = 1; i <= 5; i++) {
    const diff = r - (i - 1);
    if (diff >= 0.75) stars.push({ filled: true, half: false });
    else if (diff >= 0.25) stars.push({ filled: false, half: true });
    else stars.push({ filled: false, half: false });
  }
  return stars;
}

function formatReviews(n, compact) {
  if (n == null) return '0';
  if (compact) {
    if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
    return String(n);
  }
  return n.toLocaleString('en-US');
}

const SIZE_MAP = {
  sm: { fontSize: '0.875rem', starSize: '1rem', gap: '0.375rem' },
  md: { fontSize: '1rem',     starSize: '1.25rem', gap: '0.5rem' },
  lg: { fontSize: '1.125rem', starSize: '1.5rem', gap: '0.5rem' },
};

export default function ReviewStars({ rating, reviews, size = 'sm', compact = false }) {
  const stars = buildStars(rating);
  const s = SIZE_MAP[size] || SIZE_MAP.sm;

  // If no rating data, render nothing (caller can decide to show something else)
  if (!rating && !reviews) return null;

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: s.gap,
        fontSize: s.fontSize,
        color: '#4b5563', // neutral gray-700 for the text
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          fontSize: s.starSize,
          lineHeight: 1,
          letterSpacing: '0.03em',
        }}
        aria-label={`${rating?.toFixed(1) || '0'} out of 5 stars`}
      >
        {stars.map((star, i) => (
          <span
            key={i}
            style={{
              color: star.filled || star.half ? '#f97316' : '#d1d5db', // orange-500 filled, gray-300 empty
              position: 'relative',
              display: 'inline-block',
            }}
          >
            {star.half ? (
              // Half star: render orange left half over gray full star
              <>
                <span style={{ color: '#d1d5db' }}>{STAR_FILLED}</span>
                <span
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    overflow: 'hidden',
                    width: '50%',
                    color: '#f97316',
                  }}
                >
                  {STAR_FILLED}
                </span>
              </>
            ) : (
              STAR_FILLED
            )}
          </span>
        ))}
      </span>
      {rating != null && (
        <span style={{ fontWeight: 600, color: '#374151' }}>
          {Number(rating).toFixed(1)}
        </span>
      )}
      {reviews != null && reviews > 0 && (
        <span style={{ color: '#6b7280' }}>
          ({formatReviews(reviews, compact)}{compact ? '' : ` review${reviews === 1 ? '' : 's'}`})
        </span>
      )}
    </div>
  );
}
