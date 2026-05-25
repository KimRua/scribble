import { ProductShell } from './components/ProductShell';
import { ToastProvider } from './components/ToastProvider';

export default function App() {
  return (
    <ToastProvider>
      <ProductShell />
    </ToastProvider>
  );
}
