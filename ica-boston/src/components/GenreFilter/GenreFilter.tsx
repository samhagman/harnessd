import { Book } from "../../data/books";
import styles from "./GenreFilter.module.css";

interface Props {
  books: Book[];
  selectedGenre: string;
  onGenreChange: (genre: string) => void;
}

export default function GenreFilter({ books, selectedGenre, onGenreChange }: Props) {
  const genres = [...new Set(books.map((b) => b.genre))].sort();

  return (
    <div className={styles.wrapper}>
      <label htmlFor="genre-select" className={styles.label}>
        Filter by genre
      </label>
      <div className={styles.selectWrapper}>
        <select
          id="genre-select"
          className={styles.select}
          value={selectedGenre}
          onChange={(e) => onGenreChange(e.target.value)}
        >
          <option value="">All Genres</option>
          {genres.map((genre) => (
            <option key={genre} value={genre}>
              {genre}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
