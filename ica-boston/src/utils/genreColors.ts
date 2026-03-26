const genreColors: Record<string, string> = {
  Fiction: "#2563EB",
  "Science Fiction": "#6D28D9",
  "Non-Fiction": "#065F46",
  Fantasy: "#B45309",
  Mystery: "#374151",
  Thriller: "#9B1C1C",
  Biography: "#1E3A5F",
  History: "#5B3E1E",
};

export function getGenreColor(genre: string): string {
  return genreColors[genre] ?? "#4B5563";
}

export default genreColors;
