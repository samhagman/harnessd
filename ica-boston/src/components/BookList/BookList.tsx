import { Book } from "../../data/books";
import BookCard from "../BookCard/BookCard";
import styles from "./BookList.module.css";

interface Props {
  books: Book[];
}

export default function BookList({ books }: Props) {
  return (
    <div className={styles.grid}>
      {books.map((book) => (
        <BookCard key={book.id} book={book} />
      ))}
    </div>
  );
}
