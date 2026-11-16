import { Button } from 'antd';
import { AppIcon } from './app-icon';

export function AppearanceToggle({
  dark,
  pending,
  onToggle,
}: {
  dark: boolean;
  pending: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      type="text"
      className="iconbtn"
      aria-label="全平台外观"
      icon={<AppIcon name={dark ? 'moon' : 'sun'} />}
      disabled={pending}
      onClick={onToggle}
    />
  );
}
