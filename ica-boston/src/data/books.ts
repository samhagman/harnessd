export interface Book {
  id: string;
  title: string;
  author: string;
  genre: string;
  rating: number;
  coverColor: string;
}

export const books: Book[] = [
  {
    id: "1",
    title: "The Remains of the Day",
    author: "Kazuo Ishiguro",
    genre: "Fiction",
    rating: 4.5,
    coverColor: "#8b7355",
  },
  {
    id: "2",
    title: "Dune",
    author: "Frank Herbert",
    genre: "Science Fiction",
    rating: 5.0,
    coverColor: "#c4684a",
  },
  {
    id: "3",
    title: "Sapiens",
    author: "Yuval Noah Harari",
    genre: "Non-Fiction",
    rating: 3.2,
    coverColor: "#5c7d8a",
  },
  {
    id: "4",
    title: "Normal People",
    author: "Sally Rooney",
    genre: "Fiction",
    rating: 4.1,
    coverColor: "#b8967a",
  },
  {
    id: "5",
    title: "Project Hail Mary",
    author: "Andy Weir",
    genre: "Science Fiction",
    rating: 4.8,
    coverColor: "#6b8e6b",
  },
];
