/** @type {import('tailwindcss').Config} */
// FPT Academy design tokens - matches the approved admin mockup.
// Light-only by design (no `dark:` variants anywhere; index.html pins
// color-scheme: light).
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // FPT green - primary actions, active nav, positive badges.
        brand: {
          50: "#EDF7E5",
          100: "#D8EFC8",
          500: "#7CC950",
          600: "#6BBF3E",
          700: "#4C9127",
          800: "#3B7220",
        },
        // FPT blue - links, secondary emphasis, informational badges.
        blue: {
          50: "#E4F0F6",
          100: "#C9E1EC",
          600: "#2E86AB",
          700: "#22688A",
        },
        // Cool, slightly blue-biased neutrals so greys read as chosen.
        ink: {
          DEFAULT: "#15242F",
          muted: "#566774",
          faint: "#8A98A4",
        },
        surface: {
          DEFAULT: "#FFFFFF",
          2: "#FBFCFE",
          bg: "#F4F7FA",
        },
        line: {
          DEFAULT: "#E5EBF1",
          strong: "#D2DCE4",
        },
        // Semantic accents for badges (separate from the brand accent).
        amber: { 50: "#FAEFDA", 700: "#C77A15" },
        teal: { 50: "#DFF1F1", 700: "#128C8C" },
      },
      fontFamily: {
        display: ['"Manrope"', "system-ui", "sans-serif"],
        sans: ['"Public Sans"', "system-ui", "-apple-system", "sans-serif"],
      },
      boxShadow: {
        card: "0 1px 2px rgba(21,36,47,.04), 0 4px 16px rgba(21,36,47,.05)",
        lift: "0 2px 6px rgba(21,36,47,.06), 0 12px 32px rgba(21,36,47,.09)",
        btn: "0 1px 2px rgba(76,145,39,.3)",
      },
      borderRadius: {
        card: "13px",
      },
    },
  },
  plugins: [],
};
