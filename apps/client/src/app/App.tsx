import { BrowserRouter, Route, Routes } from "react-router-dom";
import { ExplorePage } from "../pages/ExplorePage";
import { HomePage } from "../pages/HomePage";
import { NewRepoPage } from "../pages/NewRepoPage";
import { ProfilePage } from "../pages/ProfilePage";
import { ProjectPage } from "../pages/ProjectPage";
import { SessionView } from "../session/SessionView";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/s/:sessionId" element={<SessionView />} />
        <Route path="/new" element={<NewRepoPage />} />
        <Route path="/p/:repoId" element={<ProjectPage />} />
        <Route path="/u/:userId" element={<ProfilePage />} />
        <Route path="/explore" element={<ExplorePage />} />
      </Routes>
    </BrowserRouter>
  );
}
