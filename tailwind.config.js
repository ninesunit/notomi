/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{js,jsx,ts,tsx}', './src/**/*.{js,jsx,ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        // Warm "paper" workspace palette.
        paper: '#F7F5EE',
        surface: '#FFFFFF',
        sand: '#EFEBE0',
        line: '#E3DED1',
        ink: '#1B1A17',
        muted: '#6F6A5F',
        subtle: '#9A9488',
        accent: '#B4552D',
        'accent-soft': '#F5E5DA',
        pine: '#2E6F5E',
        'pine-soft': '#E1EDE8',
        amber: '#B4832A',
        'amber-soft': '#F7EDD8',
        rose: '#B0443E',
        'rose-soft': '#F7E2E1',
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        serif: ['ui-serif', 'Iowan Old Style', 'Georgia', 'serif'],
      },
    },
  },
  plugins: [],
};
