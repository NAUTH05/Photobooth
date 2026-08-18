const IDENTITY = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1]
];

const clamp = (value, minimum = 0, maximum = 1) => Math.max(minimum, Math.min(maximum, Number(value)));

function multiply(left, right) {
  return left.map((row) => right[0].map((_value, column) => (
    row.reduce((sum, value, index) => sum + value * right[index][column], 0)
  )));
}

function multiplyVector(matrix, vector) {
  return matrix.map((row) => row.reduce((sum, value, index) => sum + value * vector[index], 0));
}

function compose(current, matrix, bias = [0, 0, 0]) {
  const transformedBias = multiplyVector(matrix, current.bias).map((value, index) => value + bias[index]);
  return { matrix: multiply(matrix, current.matrix), bias: transformedBias };
}

function brightness(amount) {
  return { matrix: IDENTITY.map((row) => row.map((value) => value * amount)), bias: [0, 0, 0] };
}

function contrast(amount) {
  return { matrix: IDENTITY.map((row) => row.map((value) => value * amount)), bias: Array(3).fill(0.5 * (1 - amount)) };
}

function saturate(amount) {
  return {
    matrix: [
      [0.213 + 0.787 * amount, 0.715 - 0.715 * amount, 0.072 - 0.072 * amount],
      [0.213 - 0.213 * amount, 0.715 + 0.285 * amount, 0.072 - 0.072 * amount],
      [0.213 - 0.213 * amount, 0.715 - 0.715 * amount, 0.072 + 0.928 * amount]
    ],
    bias: [0, 0, 0]
  };
}

function sepia(amount) {
  const level = clamp(amount);
  const target = [
    [0.393, 0.769, 0.189],
    [0.349, 0.686, 0.168],
    [0.272, 0.534, 0.131]
  ];
  return {
    matrix: IDENTITY.map((row, rowIndex) => row.map((value, columnIndex) => (
      value * (1 - level) + target[rowIndex][columnIndex] * level
    ))),
    bias: [0, 0, 0]
  };
}

function hueRotate(degrees) {
  const radians = Number(degrees) * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    matrix: [
      [0.213 + cosine * 0.787 - sine * 0.213, 0.715 - cosine * 0.715 - sine * 0.715, 0.072 - cosine * 0.072 + sine * 0.928],
      [0.213 - cosine * 0.213 + sine * 0.143, 0.715 + cosine * 0.285 + sine * 0.140, 0.072 - cosine * 0.072 - sine * 0.283],
      [0.213 - cosine * 0.213 - sine * 0.787, 0.715 - cosine * 0.715 + sine * 0.715, 0.072 + cosine * 0.928 + sine * 0.072]
    ],
    bias: [0, 0, 0]
  };
}

const operationFactories = {
  brightness,
  contrast,
  saturate,
  grayscale: (amount) => saturate(1 - clamp(amount)),
  sepia,
  hueRotate
};

function buildTransform(operations) {
  return operations.reduce((current, [name, amount]) => {
    const operation = operationFactories[name](amount);
    return compose(current, operation.matrix, operation.bias);
  }, { matrix: IDENTITY, bias: [0, 0, 0] });
}

function preset({ id, label, description, css, swatch, operations = [] }) {
  return Object.freeze({ id, label, description, css, swatch, ...buildTransform(operations) });
}

export const PHOTO_FILTERS = Object.freeze([
  preset({
    id: 'natural',
    label: 'Tự nhiên',
    description: 'Trong trẻo và chân thật',
    css: 'none',
    swatch: 'linear-gradient(135deg, #f8d7c7 0%, #f6f1de 48%, #92c5b7 100%)'
  }),
  preset({
    id: 'warm-film',
    label: 'Film ấm',
    description: 'Dịu ấm, đậm chất ảnh phim',
    css: 'brightness(1.04) contrast(1.06) saturate(0.9) sepia(0.13)',
    swatch: 'linear-gradient(135deg, #f5d39b, #dc8c62 52%, #76594f)',
    operations: [['brightness', 1.04], ['contrast', 1.06], ['saturate', 0.9], ['sepia', 0.13]]
  }),
  preset({
    id: 'black-white',
    label: 'Đen trắng',
    description: 'Cổ điển và giàu tương phản',
    css: 'grayscale(1) contrast(1.12) brightness(1.02)',
    swatch: 'linear-gradient(135deg, #f4f4ef, #9c9b96 50%, #292929)',
    operations: [['grayscale', 1], ['contrast', 1.12], ['brightness', 1.02]]
  }),
  preset({
    id: 'vintage',
    label: 'Vintage',
    description: 'Phai màu và mềm mại',
    css: 'sepia(0.3) saturate(0.76) contrast(0.92) brightness(1.06)',
    swatch: 'linear-gradient(135deg, #ead9ae, #b98264 52%, #78846b)',
    operations: [['sepia', 0.3], ['saturate', 0.76], ['contrast', 0.92], ['brightness', 1.06]]
  }),
  preset({
    id: 'cinematic',
    label: 'Điện ảnh',
    description: 'Trầm sâu và nổi khối',
    css: 'contrast(1.16) saturate(0.82) brightness(0.98) hue-rotate(-6deg)',
    swatch: 'linear-gradient(135deg, #d7a162, #385f64 54%, #172d35)',
    operations: [['contrast', 1.16], ['saturate', 0.82], ['brightness', 0.98], ['hueRotate', -6]]
  }),
  preset({
    id: 'peach',
    label: 'Hồng đào',
    description: 'Sáng nhẹ và tươi xinh',
    css: 'brightness(1.08) contrast(0.9) saturate(0.86) sepia(0.08) hue-rotate(-5deg)',
    swatch: 'linear-gradient(135deg, #fff0e3, #f5afad 52%, #d988a0)',
    operations: [['brightness', 1.08], ['contrast', 0.9], ['saturate', 0.86], ['sepia', 0.08], ['hueRotate', -5]]
  })
]);

const filtersById = new Map(PHOTO_FILTERS.map((item) => [item.id, item]));

export function normalizePhotoFilterId(value) {
  const id = String(value || '').trim().toLowerCase();
  return filtersById.has(id) ? id : 'natural';
}

export function photoFilter(value) {
  return filtersById.get(normalizePhotoFilterId(value));
}
