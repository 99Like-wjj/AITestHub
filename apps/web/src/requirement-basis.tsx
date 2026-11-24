import { Alert, Button, Space, Tag } from 'antd';

type RequirementBasis = {
  requirementId: string;
  basisVersionId: string;
  warning: string | null;
};

export function requirementMaterialsHref(
  projectId: string,
  requirementId: string,
  versionId?: string,
) {
  const params = new URLSearchParams({ projectId, requirementId });
  if (versionId) params.set('requirementVersionId', versionId);
  return '#requirements?' + params.toString();
}

export function RequirementBasisTag({
  basis,
}: {
  basis: RequirementBasis | undefined;
}) {
  return basis?.warning ? <Tag color="gold">基于旧资料</Tag> : null;
}

export function RequirementBasisNotice({
  projectId,
  basis,
  showLinks = false,
}: {
  projectId: string;
  basis: RequirementBasis | undefined;
  showLinks?: boolean;
}) {
  if (!basis || (!basis.warning && !showLinks)) return null;
  const links = (
    <Space wrap>
      <Button
        size="small"
        href={requirementMaterialsHref(
          projectId,
          basis.requirementId,
          basis.basisVersionId,
        )}
      >
        查看采用的资料
      </Button>
      <Button
        size="small"
        href={requirementMaterialsHref(projectId, basis.requirementId)}
      >
        查看当前需求资料
      </Button>
    </Space>
  );
  return basis.warning ? (
    <Alert
      type="warning"
      showIcon
      title="基于旧资料"
      description={
        <>
          <p>采用的资料与需求已固定的资料不同。</p>
          {links}
        </>
      }
    />
  ) : (
    links
  );
}
