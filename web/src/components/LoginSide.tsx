import { Logo, Leaf } from './Logo';
import { IS_SB } from '../api';

/** Lado verde das telas de entrada (some no celular) */
export function LoginSide() {
  return (
    <div className="login-side">
      <Logo size={40} light />
      <div>
        <div className="slogan">O caixa da banca.</div>
        <p className="login-lead">
          {IS_SB ? 'Pesa, toca no atalho, recebe. No celular e no computador, com as mesmas vendas, o mesmo estoque e o mesmo fiado.'
            : 'Pesa, toca no atalho, recebe. Funciona sem internet, do primeiro freguês até fechar a banca.'}
        </p>
      </div>
      <div className="feira" aria-hidden>🍅 🍌 🥬 🧅 🥕 🍊 🍉</div>
      <div className="leaf-bg" aria-hidden><Leaf size={340} color="#8FBF3F" vein="#1F7A4D" /></div>
    </div>
  );
}

export function MobileBrand() {
  return (
    <div className="login-logo-mobile">
      <Logo size={30} />
      <div className="slogan-sm">O caixa da banca.</div>
    </div>
  );
}
