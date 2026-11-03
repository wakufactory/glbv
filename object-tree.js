// Keep each node's own visibility when an ancestor hides its subtree.
export function renderObjectTree(container, root) {
  const document = container.ownerDocument;
  const entries = [];
  function build(object, depth, index) {
    const item = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'object-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = object.visible;
    const name = object.name || `${object.type || 'Node'} ${index + 1}`;
    checkbox.setAttribute('aria-label', `${name} の表示`);
    const label = document.createElement('label');
    const text = document.createElement('span');
    text.textContent = name;
    text.title = name;
    const type = document.createElement('small');
    type.textContent = object.type || 'Node';
    label.append(checkbox, text, type);
    row.append(label);
    entries.push({ object, checkbox, row });
    checkbox.addEventListener('change', () => {
      object.visible = checkbox.checked;
      refresh();
    });
    if (object.children.length) {
      const details = document.createElement('details');
      details.open = depth < 2;
      const summary = document.createElement('summary');
      summary.append(row);
      const children = document.createElement('ul');
      object.children.forEach((child, i) => children.append(build(child, depth + 1, i)));
      details.append(summary, children);
      item.append(details);
    } else {
      row.classList.add('object-leaf');
      item.append(row);
    }
    return item;
  }
  function refresh() {
    const effective = new Map();
    for (const { object, checkbox, row } of entries) {
      const ancestorHidden = effective.get(object.parent) === false;
      effective.set(object, object.visible && !ancestorHidden);
      checkbox.checked = object.visible;
      row.classList.toggle('ancestor-hidden', ancestorHidden);
      row.classList.toggle('node-hidden', !object.visible);
      row.title = ancestorHidden ? '親ノードが非表示です' : '';
    }
  }
  const list = document.createElement('ul');
  list.append(build(root, 0, 0));
  container.replaceChildren(list);
  refresh();
}
