import { ArrowDownOutlined } from '@ant-design/icons';

export function WorkspaceJumpLatest({
  mode,
  onJump,
}: {
  mode: 'generating' | 'completed' | 'idle';
  onJump: () => void;
}) {
  const label =
    mode === 'generating'
      ? '正在生成，回到底部'
      : mode === 'completed'
        ? '回到最新回复'
        : '回到底部';
  return (
    <button
      className={`jump-latest${mode === 'completed' ? '' : ' jump-latest-circle'}`}
      type="button"
      onClick={onJump}
      aria-label={label}
      title={label}
      data-jump-mode={mode}
    >
      {mode === 'generating' ? (
        <span className="workspace-jump-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      ) : (
        <>
          <ArrowDownOutlined aria-hidden="true" />
          {mode === 'completed' && <span>最新回复</span>}
        </>
      )}
    </button>
  );
}
