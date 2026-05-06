import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        turquoise: {
          DEFAULT: "#40e0d0",
          deep: "#1dbdb0",
          soft: "#d8fbf7"
        }
      },
      boxShadow: {
        halo: "0 10px 30px rgba(64, 224, 208, 0.12)"
      }
    }
  },
  plugins: []
};

export default config;