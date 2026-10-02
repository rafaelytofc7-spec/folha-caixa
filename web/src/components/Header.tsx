import { useApp } from '../ctx';
import { Logo } from './Logo';
import { ROLE_LABEL } from '@folha/shared';
import { getTerminal } from '../api';

const NAV: Array<[string, string, string, ('admin' | 'gerente' | 'operador')[]?]> = [
  ['venda', '🛒', 'Venda'], ['caixa', '💵', 'Caixa'], ['vendas', '🧾', 'Vendas'], ['fiado', '📒', 'Fiado'],
  ['estoque', '🧺', 'Estoque'], ['produtos', '🥕', 'Produtos', ['admin', 'gerente']],
  ['relatorios', '📊', 'Relatórios', ['admin', 'gerente']], ['config', '⚙️', 'Config.', ['admin', 'gerente']],
];

export function Header() {
  const { user, status, route, go, logout } = useApp();
  const open = status?.session?.session;
  const alerts = (status?.alerts?.expiring?.length ?? 0);
  return (
    <header className="header no-print">
      <Logo size={28} light />
      <div className="sep" />
      <div className="store" title={status?.store?.name}>{status?.store?.name ?? '…'}</div>
      <span className={`status-pill ${open ? 'aberto' : 'fechado'}`} title={open ? `Aberto por ${open.opened_by_name}` : 'Caixa fechado'}
        onClick={() => go('caixa')} style={{ cursor: 'pointer' }}>
        <span className="dot" />{open ? 'Caixa aberto' : 'Caixa fechado'} <span style={{ opacity: .75, fontWeight: 600 }}>{getTerminal()}</span>
      </span>
      {alerts > 0 && <button className="alert-badge" onClick={() => go('estoque/vencendo')} title="Itens vencendo">⚠ {alerts} vencendo</button>}
      <nav className="nav">
        {NAV.filter((n) => !n[3] || (user && n[3].includes(user.role))).map(([r, ic, tx]) => (
          <button key={r} className={route.split('/')[0] === r ? 'on' : ''} onClick={() => go(r)} title={tx}>
            <span className="ic">{ic}</span><span className="tx">{tx}</span>
          </button>
        ))}
      </nav>
      <div className="userbox">
        <div className="who"><b>{user?.name}</b><span style={{ opacity: .8 }}>{user ? ROLE_LABEL[user.role] : ''}</span></div>
        <button className="btn btn-sm" style={{ background: 'rgba(255,255,255,.12)', color: '#fff', borderColor: 'transparent' }} onClick={logout}>Sair</button>
      </div>
    </header>
  );
}
