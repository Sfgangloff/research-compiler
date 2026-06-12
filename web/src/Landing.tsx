// Landing page: choose one of the two workspaces.
export function Landing() {
  return (
    <div className="landing">
      <div className="landing-inner">
        <h1>🧭 Research Compiler</h1>
        <p className="landing-sub">Choose a workspace.</p>
        <div className="landing-cards">
          <a className="landing-card" href="#/reasoning">
            <div className="landing-card-icon">🧠</div>
            <h2>Reasoning graphs</h2>
            <p>Build and explore structured research reasoning — questions, answers,
              experiments, and storylines across your research streams.</p>
            <span className="landing-go">Open →</span>
          </a>
          <a className="landing-card" href="#/literature">
            <div className="landing-card-icon">📚</div>
            <h2>ML literature review</h2>
            <p>Cluster recent top-conference ML papers (NeurIPS / ICML / ICLR) and surface
              the most influential reading list per cluster — to stay up to date.</p>
            <span className="landing-go">Open →</span>
          </a>
        </div>
      </div>
    </div>
  );
}
