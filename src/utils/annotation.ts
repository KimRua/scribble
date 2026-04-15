import type { Annotation, ChartAnchor, DrawingObject, Strategy } from '../types/domain';

function isStrategyManagedDrawingObject(annotationId: string, object: DrawingObject) {
  return (
    object.id === `${annotationId}_entry` ||
    object.id === `${annotationId}_sl` ||
    object.id.startsWith(`${annotationId}_tp_`) ||
    object.id === `${annotationId}_zone` ||
    object.id === `${annotationId}_note`
  );
}

export function buildDrawingObjectsFromStrategy(strategy: Strategy, noteText?: string): DrawingObject[] {
  const objects: DrawingObject[] = [
    { id: `${strategy.annotationId}_entry`, type: 'line', role: 'entry', price: strategy.entryPrice },
    { id: `${strategy.annotationId}_sl`, type: 'line', role: 'stop_loss', price: strategy.stopLossPrice },
    ...strategy.takeProfitPrices.map((price, index) => ({
      id: `${strategy.annotationId}_tp_${index}`,
      type: 'line' as const,
      role: 'take_profit' as const,
      price
    })),
    {
      id: `${strategy.annotationId}_zone`,
      type: 'box',
      role: 'zone',
      priceFrom: Math.min(strategy.entryPrice, strategy.stopLossPrice),
      priceTo: Math.max(strategy.entryPrice, strategy.stopLossPrice)
    }
  ];

  if (noteText) {
    objects.push({
      id: `${strategy.annotationId}_note`,
      type: 'text',
      role: 'note',
      text: noteText
    });
  }

  return objects;
}

export function createAnnotationFromText(params: {
  annotationId: string;
  symbol: string;
  timeframe: string;
  text: string;
  authorType: Annotation['authorType'];
  authorId: string;
  ownerKey?: string | null;
  anchor: ChartAnchor;
  strategy: Strategy;
}): Annotation {
  const now = new Date().toISOString();
  return {
    annotationId: params.annotationId,
    authorType: params.authorType,
    authorId: params.authorId,
    ownerKey: params.ownerKey ?? null,
    marketSymbol: params.symbol,
    timeframe: params.timeframe,
    text: params.text,
    chartAnchor: params.anchor,
    drawingObjects: buildDrawingObjectsFromStrategy(params.strategy, params.text),
    strategy: params.strategy,
    status: 'Draft',
    visibility: 'private',
    createdAt: now,
    updatedAt: now
  };
}

export function syncAnnotationWithStrategy(annotation: Annotation, strategy: Strategy, text = annotation.text): Annotation {
  const customDrawingObjects = annotation.drawingObjects.filter(
    (object) => !isStrategyManagedDrawingObject(annotation.annotationId, object)
  );

  return {
    ...annotation,
    text,
    strategy,
    drawingObjects: [...buildDrawingObjectsFromStrategy(strategy, text), ...customDrawingObjects],
    updatedAt: new Date().toISOString()
  };
}
