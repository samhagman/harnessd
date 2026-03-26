import { Book } from "../../data/books";
import BookCard from "../BookCard/BookCard";
import styles from "./BookList.module.css";

interface Props {
  books: Book[];
  filterKey: string;
}

export default function BookList({ books }: Props) {
  return (
    <div className={styles.grid}>
      {books.map((book, index) => (
        <BookCard key={book.id} book={book} index={index} />
      ))}
    </div>
  );
}
