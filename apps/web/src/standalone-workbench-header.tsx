import { ArrowLeftOutlined } from '@ant-design/icons';
import { Button, Typography } from 'antd';
import './standalone-workbench-header.css';

type BackAction =
  | { backHref: string; onBack?: never; backDisabled?: never }
  | { backHref?: never; onBack: () => void; backDisabled?: boolean };

export function StandaloneWorkbenchHeader(
  props: BackAction & {
    title: string;
    projectName: string;
    backLabel: string;
  },
) {
  const returnAction =
    props.backHref !== undefined
      ? { href: props.backHref }
      : { onClick: props.onBack, disabled: props.backDisabled ?? false };

  return (
    <header className="standalone-workbench-header">
      <div className="standalone-workbench-header-left">
        <img src="/brand-f-horizontal.png" alt="AITestHub" />
        <Button
          type="primary"
          icon={<ArrowLeftOutlined />}
          aria-label={props.backLabel}
          {...returnAction}
        >
          {props.backLabel}
        </Button>
        <Typography.Text strong>{props.title}</Typography.Text>
      </div>
      <Typography.Text
        type="secondary"
        className="standalone-workbench-project"
        title={props.projectName}
      >
        {props.projectName}
      </Typography.Text>
    </header>
  );
}
