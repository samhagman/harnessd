import { books } from "./data/books";
import BookList from "./components/BookList/BookList";
import styles from "./App.module.css";

export default function App() {
  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <h1 className={styles.title}>The Reading List</h1>
          <p className={styles.subtitle}>
            {books.length} carefully chosen books
          </p>
        </div>
      </header>
      <main className={styles.main}>
        <BookList books={books} />
      </main>
    </div>
  );
}
