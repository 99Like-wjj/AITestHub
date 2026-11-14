import { Switch } from 'antd';
import { useId } from 'react';

export function ArchivedRequirementsToggle({
  checked,
  onChange,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <label className="archived-requirements-toggle" htmlFor={id}>
      <Switch
        id={id}
        size="small"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        aria-label="显示已归档需求"
      />
      <span>显示已归档需求</span>
    </label>
  );
}
