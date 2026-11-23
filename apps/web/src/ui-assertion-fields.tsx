import { Button, Form, Input, Space, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';

export type UiAssertionDraft = {
  id: string;
  expected: string;
  evidenceHint?: string | undefined;
};

export function uiAssertionContent(items: UiAssertionDraft[] | undefined) {
  return items?.length
    ? {
        assertions: items.map(({ id, expected, evidenceHint }) => ({
          id,
          expected,
          ...(evidenceHint?.trim()
            ? { evidenceHint: evidenceHint.trim() }
            : {}),
        })),
      }
    : {};
}

export function UiAssertionFields({
  disabled = false,
}: {
  disabled?: boolean;
}) {
  return (
    <Form.List name="assertions">
      {(fields, { add, remove }) => (
        <section aria-label="业务断言与取证参考">
          <Typography.Title level={5}>业务断言与取证参考</Typography.Title>
          {fields.map(({ key, name }) => (
            <div key={key} className="panel pad mb">
              <Form.Item name={[name, 'id']} hidden>
                <Input />
              </Form.Item>
              <Form.Item
                label="可核对的预期"
                name={[name, 'expected']}
                rules={[{ required: true, whitespace: true }]}
              >
                <Input.TextArea
                  rows={2}
                  maxLength={10000}
                  disabled={disabled}
                />
              </Form.Item>
              <Form.Item label="取证参考（可选）" name={[name, 'evidenceHint']}>
                <Input.TextArea rows={2} maxLength={2000} disabled={disabled} />
              </Form.Item>
              <Button
                danger
                size="small"
                disabled={disabled}
                onClick={() => remove(name)}
              >
                移除断言
              </Button>
            </div>
          ))}
          <Space className="mb">
            <Button
              size="small"
              icon={<PlusOutlined />}
              disabled={disabled || fields.length >= 100}
              onClick={() => add({ id: crypto.randomUUID(), expected: '' })}
            >
              添加业务断言
            </Button>
          </Space>
        </section>
      )}
    </Form.List>
  );
}
