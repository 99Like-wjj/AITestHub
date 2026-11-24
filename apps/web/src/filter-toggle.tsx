import { Switch } from 'antd';
import { useId } from 'react';

export function FilterToggle({
  checked,
  onChange,
  disabled = false,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  const id = useId();
  return (
    <label className="filter-toggle" htmlFor={id}>
      <Switch
        id={id}
        size="small"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        aria-label={label}
      />
      <span>{label}</span>
    </label>
  );
}
