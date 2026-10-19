import { Route, Routes } from 'react-router-dom';
import Layout from './Layout';
import BusinessPage from './pages/BusinessPage';
import DownloadPage from './pages/DownloadPage';
import FaqPage from './pages/FaqPage';
import GameDetailPage from './pages/GameDetailPage';
import HotGamePage from './pages/HotGamePage';
import GamesPage from './pages/GamesPage';
import GuidePage from './pages/GuidePage';
import GuidesPage from './pages/GuidesPage';
import HomePage from './pages/HomePage';
import NotFoundPage from './pages/NotFoundPage';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<HomePage />} />
        <Route path="games" element={<GamesPage />} />
        <Route path="games/hot/:id" element={<HotGamePage />} />
        <Route path="games/:slug" element={<GameDetailPage />} />
        <Route path="guides" element={<GuidesPage />} />
        <Route path="guides/:slug" element={<GuidePage />} />
        <Route path="faq" element={<FaqPage />} />
        <Route path="business" element={<BusinessPage />} />
        <Route path="download" element={<DownloadPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
