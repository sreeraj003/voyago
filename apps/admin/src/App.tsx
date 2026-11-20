import { NavLink, Route, Routes } from 'react-router-dom';
import { HealthPanel } from './HealthPanel';

export function App() {
  return (
    <div className="layout">
      <header className="topbar">
        <strong>Voyago Admin</strong>
        <nav aria-label="Main">
          <NavLink to="/">Overview</NavLink>
        </nav>
      </header>
      <main className="content">
        <Routes>
          <Route
            path="/"
            element={
              <>
                <h1>Overview</h1>
                <HealthPanel />
              </>
            }
          />
          <Route path="*" element={<h1>Page not found</h1>} />
        </Routes>
      </main>
    </div>
  );
}
