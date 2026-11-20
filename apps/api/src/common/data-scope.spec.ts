import { scopeWhere } from './data-scope';

describe('scopeWhere 数据范围', () => {
  const base = { id: 'u1', teamId: 't1' };

  it('本人：只看自己负责的', () => {
    expect(scopeWhere({ ...base, dataScope: 'SELF' })).toEqual({ ownerId: 'u1' });
  });

  it('本小组：按小组过滤', () => {
    expect(scopeWhere({ ...base, dataScope: 'TEAM' })).toEqual({ teamId: 't1' });
  });

  it('本小组但没分组：退回只看自己', () => {
    expect(scopeWhere({ id: 'u1', teamId: null, dataScope: 'TEAM' })).toEqual({ ownerId: 'u1' });
  });

  it('全部：不限制', () => {
    expect(scopeWhere({ ...base, dataScope: 'ALL' })).toEqual({});
  });

  it('支持自定义字段名', () => {
    expect(scopeWhere({ ...base, dataScope: 'SELF' }, { ownerField: 'salesId' })).toEqual({
      salesId: 'u1',
    });
  });
});
