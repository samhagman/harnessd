import { useState } from "react";
import { books } from "./data/books";
import BookList from "./components/BookList/BookList";
import GenreFilter from "./components/GenreFilter/GenreFilter";
import EmptyState from "./components/EmptyState/EmptyState";
import styles from "./App.module.css";

export default function App() {
  const [selectedGenre, setSelectedGenre] = useState<string>("");

  const filteredBooks =
    selectedGenre === ""
      ? books
      : books.filter((b) => b.genre === selectedGenre);

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <h1 className={styles.title}>The Reading List</h1>
          <p className={styles.subtitle}>{books.length} carefully chosen books</p>
        </div>
      </header>
      <main className={styles.main}>
        <div className={styles.filterBar}>
          <GenreFilter
            books={books}
            selectedGenre={selectedGenre}
            onGenreChange={setSelectedGenre}
          />
          <p className={styles.count}>
            Showing {filteredBooks.length} of {books.length} books
          </p>
        </div>
        {filteredBooks.length === 0 ? (
          <EmptyState onReset={() => setSelectedGenre("")} />
        ) : (
          <BookList key={selectedGenre} books={filteredBooks} filterKey={selectedGenre} />
        )}
      </main>
    </div>
  );
}
