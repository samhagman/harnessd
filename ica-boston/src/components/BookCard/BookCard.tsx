import { Book } from "../../data/books";
import { getGenreColor } from "../../utils/genreColors";
import StarRating from "../StarRating/StarRating";
import styles from "./BookCard.module.css";

interface Props {
  book: Book;
}

export default function BookCard({ book }: Props) {
  const badgeColor = getGenreColor(book.genre);

  return (
    <article
      className={styles.card}
      style={{ "--accent-color": book.coverColor } as React.CSSProperties}
    >
      <div className={styles.body}>
        <h2 className={styles.title}>{book.title}</h2>
        <p className={styles.author}>{book.author}</p>
        <div className={styles.footer}>
          <span
            className={styles.badge}
            style={{ backgroundColor: badgeColor }}
          >
            {book.genre}
          </span>
          <StarRating rating={book.rating} bookId={book.id} />
        </div>
      </div>
    </article>
  );
}
