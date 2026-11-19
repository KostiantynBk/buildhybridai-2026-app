import { createRoot } from 'react-dom/client';
import App from './ui/App';
import './ui/style.css';
import { developerRoute } from './ui/route';

const root = createRoot(document.getElementById('root')!);
if (import.meta.env.DEV && developerRoute(window.location.pathname, true) === 'eval') {
  void import('./eval/EvalPage').then(({ default: EvalPage }) => root.render(<EvalPage />));
} else {
  root.render(<App developerPlayer={import.meta.env.DEV &&
    developerRoute(window.location.pathname, true) === 'dev'} />);
}
