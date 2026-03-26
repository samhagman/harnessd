import styles from "./EmptyState.module.css";

interface Props {
  onReset: () => void;
}

export default function EmptyState({ onReset }: Props) {
  return (
    <div className={styles.container}>
      <span className={styles.emoji} aria-hidden="true">
        📚
      </span>
      <h2 className={styles.message}>No books found in this genre</h2>
      <button className={styles.resetButton} onClick={onReset}>
        Show all books
      </button>
    </div>
  );
}
