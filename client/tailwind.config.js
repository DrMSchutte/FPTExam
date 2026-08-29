/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#eef4ff",
          600: "#1f3864",
          700: "#182c50",
        },
      },
    },
  },
  plugins: [],
};
