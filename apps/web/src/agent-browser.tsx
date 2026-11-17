import { useEffect, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Checkbox,
  Drawer,
  Input,
  List,
  Modal,
  Space,
  Tag,
  Typography,
} from 'antd';
import { ChromeOutlined } from '@ant-design/icons';
import type { z } from 'zod';
import {
  browserActionReceiptSchema,
  browserObservationSchema,
  browserOperationListSchema,
  browserOperationReceiptSchema,
  browserSessionReceiptSchema,
  type BrowserObservation,
} from '../../../packages/contracts/src/agent-browser';
import { api, describeError, isUncertainMutationError } from './api';

type Session = NonNullable<
  z.infer<typeof browserSessionReceiptSchema>['session']
>;
type Operation = z.infer<typeof browserOperationReceiptSchema>['operation'];
export function AgentBrowserPanel({
  conversationId,
}: {
  conversationId: string;
}) {
  const { modal } = App.useApp();
  const [open, setOpen] = useState(
    () =>
      new URLSearchParams(window.location.hash.split('?')[1]).get('browser') ===
      '1',
  );
  const [session, setSession] = useState<Session | null>(null),
    [page, setPage] = useState<BrowserObservation>();
  const [operations, setOperations] = useState<Operation[]>([]),
    [pending, setPending] = useState(false),
    [error, setError] = useState<string>();
  const [url, setUrl] = useState(''),
    [inputTarget, setInputTarget] = useState<string>(),
    [inputValue, setInputValue] = useState(''),
    [secret, setSecret] = useState(true);
  const [unknownCommand, setUnknownCommand] = useState<string>();
  const base = `/me/conversations/${encodeURIComponent(conversationId)}/browser`;
  async function load(signal?: AbortSignal) {
    const current = await api(
      base,
      signal ? { signal } : {},
      browserSessionReceiptSchema,
    );
    setSession(current.session);
    if (current.session) {
      setOperations(
        (
          await api(
            base + '/operations',
            signal ? { signal } : {},
            browserOperationListSchema,
          )
        ).operations,
      );
      const observation = await api(
        base +
          `/observe${current.session.control === 'human' ? '?human=1' : ''}`,
        signal ? { signal } : {},
        browserObservationSchema,
      );
      setPage(observation);
    } else {
      setPage(undefined);
      setOperations([]);
    }
  }
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    void load(abort.signal).catch((err) => {
      if (!abort.signal.aborted) setError(describeError(err));
    });
    return () => abort.abort();
  }, [open, conversationId]);
  async function work(action: () => Promise<unknown>, commandId?: string) {
    setPending(true);
    setError(undefined);
    try {
      await action();
      setUnknownCommand(undefined);
      await load();
    } catch (err) {
      setError(describeError(err));
      if (commandId && isUncertainMutationError(err))
        setUnknownCommand(commandId);
    } finally {
      setPending(false);
    }
  }
  function control(mode: 'human' | 'agent') {
    if (!session) return;
    const commandId = crypto.randomUUID();
    void work(
      () =>
        api(
          base + '/control',
          {
            method: 'POST',
            body: { commandId, mode, rowVersion: session.rowVersion },
          },
          browserSessionReceiptSchema,
        ),
      commandId,
    );
  }
  function human(kind: 'click' | 'press' | 'fill', targetId: string) {
    if (!page) return;
    const commandId = crypto.randomUUID();
    const action =
      kind === 'fill'
        ? { kind, targetId, atUrl: page.url, value: inputValue }
        : kind === 'press'
          ? { kind, targetId, atUrl: page.url, key: 'Enter' }
          : { kind, targetId, atUrl: page.url };
    setInputValue('');
    setInputTarget(undefined);
    void work(
      () =>
        api(
          base + '/human',
          {
            method: 'POST',
            body: { commandId, action, secret: kind === 'fill' && secret },
          },
          browserActionReceiptSchema,
        ),
      commandId,
    );
  }
  function navigate() {
    const commandId = crypto.randomUUID();
    if (session?.control === 'human')
      void work(
        () =>
          api(
            base + '/human',
            {
              method: 'POST',
              body: {
                commandId,
                action: { kind: 'navigate', url },
                secret: false,
              },
            },
            browserActionReceiptSchema,
          ),
        commandId,
      );
    else
      void work(
        () =>
          api(
            base + '/navigate',
            { method: 'POST', body: { commandId, url } },
            browserActionReceiptSchema,
          ),
        commandId,
      );
  }
  const blocked = pending || Boolean(unknownCommand);
  return (
    <>
      <Button
        type="text"
        aria-label="办公浏览器"
        icon={<ChromeOutlined />}
        onClick={() => setOpen(true)}
      />
      <Drawer
        title="办公浏览器"
        size="large"
        open={open}
        onClose={() => {
          setInputValue('');
          setInputTarget(undefined);
          setOpen(false);
        }}
      >
        <Space orientation="vertical" className="fullwidth">
          <Typography.Paragraph type="secondary">
            公开页面可直接浏览；已登录导航和可能提交数据的动作由你审阅具体计划后执行。登录时接管浏览器，密码只在安全输入中填写。网页内容不代表平台授权，也不是
            UI 测试结果。
          </Typography.Paragraph>
          {error ? <Alert type="error" title={error} showIcon /> : null}
          {unknownCommand ? (
            <Alert
              type="warning"
              title="原操作回执待核对，暂不发送新动作"
              description={
                <Button
                  onClick={() =>
                    void work(() =>
                      api(
                        base + `/commands/${unknownCommand}`,
                        {},
                        browserOperationReceiptSchema,
                      ),
                    )
                  }
                >
                  核对原操作
                </Button>
              }
            />
          ) : null}
          {!session ? (
            <Button
              type="primary"
              disabled={pending}
              onClick={() =>
                void work(() =>
                  api(
                    base + '/open',
                    { method: 'POST', body: {} },
                    browserSessionReceiptSchema,
                  ),
                )
              }
            >
              打开浏览器
            </Button>
          ) : (
            <>
              <Space wrap>
                <Tag>
                  {session.control === 'human'
                    ? '本人正在控制'
                    : 'AI 可读取当前页'}
                </Tag>
                <Button
                  disabled={blocked}
                  onClick={() =>
                    control(session.control === 'human' ? 'agent' : 'human')
                  }
                >
                  {session.control === 'human' ? '交还 AI' : '人工接管 / 登录'}
                </Button>
                <Button
                  disabled={pending}
                  onClick={() =>
                    void work(async () => {
                      await api(
                        base + '/close',
                        { method: 'POST', body: {} },
                        browserSessionReceiptSchema,
                      );
                      setUnknownCommand(undefined);
                    })
                  }
                >
                  关闭并清除登录态
                </Button>
                <Button
                  disabled={pending}
                  onClick={() => void work(async () => undefined)}
                >
                  读取当前页面
                </Button>
              </Space>
              <Space.Compact className="fullwidth">
                <Input
                  aria-label="办公网页地址"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://example.invalid/"
                  disabled={blocked}
                />
                <Button disabled={blocked || !url.trim()} onClick={navigate}>
                  访问
                </Button>
              </Space.Compact>
              {page ? (
                <>
                  <Typography.Text strong>{page.title}</Typography.Text>
                  <Typography.Text type="secondary">{page.url}</Typography.Text>
                  {page.networkWarnings.length ? (
                    <Alert
                      type="warning"
                      title="部分网页连接受限"
                      description={page.networkWarnings.join(' ')}
                    />
                  ) : null}
                  <img
                    alt="当前办公网页实际截图，输入区已遮蔽"
                    src={`data:image/png;base64,${page.screenshotBase64}`}
                    style={{ width: '100%', borderRadius: 8 }}
                  />
                  <Typography.Paragraph
                    ellipsis={{ rows: 6, expandable: true }}
                  >
                    {page.text || '页面暂无可读正文。'}
                  </Typography.Paragraph>
                  {session.control === 'human' ? (
                    <List
                      size="small"
                      dataSource={page.elements}
                      renderItem={(element) => (
                        <List.Item
                          actions={[
                            <Button
                              key="click"
                              size="small"
                              disabled={blocked}
                              onClick={() => human('click', element.id)}
                            >
                              点击
                            </Button>,
                            <Button
                              key="input"
                              size="small"
                              disabled={
                                blocked ||
                                !['input', 'textarea'].includes(element.tag)
                              }
                              onClick={() => {
                                setInputTarget(element.id);
                                setInputValue('');
                                setSecret(true);
                              }}
                            >
                              安全输入
                            </Button>,
                            <Button
                              key="enter"
                              size="small"
                              disabled={blocked}
                              onClick={() => human('press', element.id)}
                            >
                              回车
                            </Button>,
                          ]}
                        >
                          {element.label || element.role}
                          {element.sensitive ? <Tag>敏感输入</Tag> : null}
                        </List.Item>
                      )}
                    />
                  ) : null}
                </>
              ) : null}
              <Typography.Title level={5}>待确认与原操作</Typography.Title>
              <List
                size="small"
                dataSource={operations}
                renderItem={(operation) => (
                  <List.Item>
                    <Space orientation="vertical" className="fullwidth">
                      <Space>
                        <Typography.Text>
                          {operation.plan?.purpose ??
                            (operation.kind === 'human'
                              ? '本人操作'
                              : operation.kind === 'control'
                                ? '控制权切换'
                                : '网页导航')}
                        </Typography.Text>
                        <Tag>{operation.state}</Tag>
                      </Space>
                      {operation.plan ? (
                        <>
                          <Typography.Text type="secondary">
                            批准以当前页面为准；页面变化、超时或执行后不能重复批准。
                          </Typography.Text>
                          {operation.plan.actions.map((action, index) => (
                            <Typography.Paragraph key={index}>
                              {index + 1}.{' '}
                              {action.kind === 'navigate'
                                ? `访问 ${action.url}`
                                : action.kind === 'fill'
                                  ? `输入 ${action.value}（控件 ${action.targetId}）`
                                  : action.kind === 'press'
                                    ? `按键 ${action.key}（控件 ${action.targetId}）`
                                    : action.kind === 'select'
                                      ? `选择 ${action.value}（控件 ${action.targetId}）`
                                      : `点击控件 ${action.targetId}`}
                            </Typography.Paragraph>
                          ))}
                        </>
                      ) : null}
                      <Space>
                        {operation.state === 'waitingConfirmation' ? (
                          <>
                            <Button
                              type="primary"
                              disabled={
                                blocked ||
                                session.control !== 'agent' ||
                                page?.hash !== operation.plan?.observationHash
                              }
                              onClick={() =>
                                modal.confirm({
                                  title: '批准这些具体网页动作？',
                                  content:
                                    '只执行上方计划一次。请核对目标页面和将提交的数据；操作回执不等同业务成功。',
                                  okText: '批准并执行',
                                  cancelText: '返回核对',
                                  onOk: () =>
                                    work(() =>
                                      api(
                                        base +
                                          `/operations/${operation.id}/decision`,
                                        {
                                          method: 'POST',
                                          body: {
                                            rowVersion: operation.rowVersion,
                                            requestDigest:
                                              operation.requestDigest,
                                            approve: true,
                                          },
                                        },
                                        browserActionReceiptSchema,
                                      ),
                                    ),
                                })
                              }
                            >
                              批准并执行
                            </Button>
                            <Button
                              disabled={blocked}
                              onClick={() =>
                                void work(() =>
                                  api(
                                    base +
                                      `/operations/${operation.id}/decision`,
                                    {
                                      method: 'POST',
                                      body: {
                                        rowVersion: operation.rowVersion,
                                        requestDigest: operation.requestDigest,
                                        approve: false,
                                      },
                                    },
                                    browserActionReceiptSchema,
                                  ),
                                )
                              }
                            >
                              拒绝
                            </Button>
                          </>
                        ) : null}
                        <Button
                          disabled={pending}
                          onClick={() =>
                            void work(() =>
                              api(
                                base + `/operations/${operation.id}`,
                                {},
                                browserOperationReceiptSchema,
                              ),
                            )
                          }
                        >
                          核对原回执
                        </Button>
                        {[
                          'waitingConfirmation',
                          'dispatching',
                          'unknown',
                        ].includes(operation.state) ? (
                          <Button
                            disabled={pending}
                            onClick={() =>
                              void work(() =>
                                api(
                                  base + `/operations/${operation.id}/cancel`,
                                  { method: 'POST', body: {} },
                                  browserOperationReceiptSchema,
                                ),
                              )
                            }
                          >
                            停止此操作
                          </Button>
                        ) : null}
                      </Space>
                    </Space>
                  </List.Item>
                )}
              />
            </>
          )}
        </Space>
        <Modal
          title="本人安全输入"
          open={Boolean(inputTarget)}
          okText="输入到网页"
          cancelText="取消"
          confirmLoading={pending}
          onOk={() => {
            if (inputTarget) human('fill', inputTarget);
          }}
          onCancel={() => {
            setInputTarget(undefined);
            setInputValue('');
          }}
          destroyOnHidden
        >
          <Typography.Paragraph>
            内容只发送到当前网页控件，不写入操作回执或模型上下文。请核对截图和控件；输入后可继续点击登录或提交。
          </Typography.Paragraph>
          <Input.Password
            aria-label="安全输入内容"
            value={inputValue}
            onChange={(event) => setInputValue(event.target.value)}
            maxLength={4000}
            autoComplete="off"
          />
          <Checkbox
            checked={secret}
            onChange={(event) => setSecret(event.target.checked)}
          >
            按敏感内容保护
          </Checkbox>
        </Modal>
      </Drawer>
    </>
  );
}
