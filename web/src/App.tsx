import { useApp } from './ctx';
import { Header } from './components/Header';
import { Login } from './pages/Login';
import { StoreLogin } from './pages/StoreLogin';
import { NetBanner } from './components/NetBanner';
import { Sale } from './pages/Sale';
import { Cash } from './pages/Cash';
import { Products } from './pages/Products';
import { Stock } from './pages/Stock';
import { Customers } from './pages/Customers';
import { SalesList } from './pages/SalesList';
import { Reports } from './pages/Reports';
import { Settings } from './pages/Settings';

export function App() {
  const { user, route, store } = useApp();
  if (store === 'loading') return <div className="boot">Carregando…</div>;
  if (store === 'out') return <><NetBanner /><StoreLogin /></>;
  if (!user) return <><NetBanner /><Login /></>;
  const [r, sub] = route.split('/');
  let page;
  switch (r) {
    case 'caixa': page = <Cash />; break;
    case 'produtos': page = <Products />; break;
    case 'estoque': page = <Stock tab={sub} />; break;
    case 'fiado': page = <Customers />; break;
    case 'vendas': page = <SalesList />; break;
    case 'relatorios': page = <Reports />; break;
    case 'config': page = <Settings />; break;
    default: page = <Sale />;
  }
  return (
    <div className="app">
      <Header />
      <NetBanner />
      <main className="main">{page}</main>
    </div>
  );
}
