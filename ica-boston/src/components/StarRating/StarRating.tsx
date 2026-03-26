import styles from "./StarRating.module.css";

const STAR_PATH =
  "M 12,2 L 14.35,8.76 L 21.51,8.91 L 15.80,13.24 L 17.88,20.09 L 12,16 L 6.12,20.09 L 8.20,13.24 L 2.49,8.91 L 9.65,8.76 Z";

interface StarProps {
  fillFraction: number;
  gradientId: string;
}

function Star({ fillFraction, gradientId }: StarProps) {
  const pct = Math.round(Math.min(1, Math.max(0, fillFraction)) * 100);
  return (
    <svg
      className={styles.star}
      viewBox="0 0 24 24"
      width="20"
      height="20"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset={`${pct}%`} stopColor="#F4A261" />
          <stop offset={`${pct}%`} stopColor="#E0D8CE" />
        </linearGradient>
      </defs>
      <path d={STAR_PATH} fill={`url(#${gradientId})`} />
    </svg>
  );
}

interface StarRatingProps {
  rating: number;
  bookId: string;
}

export default function StarRating({ rating, bookId }: StarRatingProps) {
  const clampedRating = Math.min(5, Math.max(0, rating));
  const displayRating = Math.round(clampedRating * 10) / 10;

  return (
    <div
      className={styles.container}
      aria-label={`Rated ${displayRating} out of 5 stars`}
      role="img"
    >
      {Array.from({ length: 5 }, (_, i) => {
        const fillFraction = Math.min(1, Math.max(0, clampedRating - i));
        const gradientId = `star-grad-${bookId}-${i}`;
        return (
          <Star key={i} fillFraction={fillFraction} gradientId={gradientId} />
        );
      })}
    </div>
  );
}
