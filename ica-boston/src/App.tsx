import styles from './App.module.css'

function App() {
  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <h1 className={styles.title}>ICA Boston</h1>
        <p className={styles.subtitle}>Institute of Contemporary Art</p>
      </header>
      <main className={styles.main}>
        <p className={styles.placeholder}>
          Sections will be composed here by downstream packets.
        </p>
      </main>
    </div>
  )
}

export default App
