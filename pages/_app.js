import '@/styles/globals.css';

export default function App({ Component, pageProps }) {
  if (!Component) {
    return null;
  }

  return <Component {...pageProps} />;
}
