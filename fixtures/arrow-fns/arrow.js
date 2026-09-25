const basic = () => {
  helper();
};

export const exported = async (id) => {
  const record = await findOne(id);
  return record;
};

async function util() {
  return exported("x");
}

const outer = () => {
  const inner = () => {
    target();
  };
  inner();
};

function target() {}

function caller() {
  basic();
}
