import { createRoot } from 'react-dom/client';
import App from './ui/App';
import './ui/style.css';

const root = createRoot(document.getElementById('root')!);
if (import.meta.env.DEV && window.location.pathname === '/eval') {
  void import('./eval/EvalPage').then(({ default: EvalPage }) => root.render(<EvalPage />));
} else {
  root.render(<App developerPlayer={import.meta.env.DEV && window.location.pathname === '/dev'} />);
}
