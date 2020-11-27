import { namedNode, quad } from '@rdfjs/data-model';
import arrayifyStream from 'arrayify-stream';
import { Algebra } from 'sparqlalgebrajs';
import * as algebra from 'sparqlalgebrajs';
import streamifyArray from 'streamify-array';
import type { BodyParserArgs } from '../../../../src/ldp/http/BodyParser';
import { SparqlUpdateBodyParser } from '../../../../src/ldp/http/SparqlUpdateBodyParser';
import { RepresentationMetadata } from '../../../../src/ldp/representation/RepresentationMetadata';
import type { HttpRequest } from '../../../../src/server/HttpRequest';
import { BadRequestHttpError } from '../../../../src/util/errors/BadRequestHttpError';
import { UnsupportedMediaTypeHttpError } from '../../../../src/util/errors/UnsupportedMediaTypeHttpError';

describe('A SparqlUpdateBodyParser', (): void => {
  const bodyParser = new SparqlUpdateBodyParser();
  let input: BodyParserArgs;

  beforeEach(async(): Promise<void> => {
    input = { request: { headers: {}} as HttpRequest, metadata: new RepresentationMetadata() };
  });

  it('only accepts application/sparql-update content.', async(): Promise<void> => {
    await expect(bodyParser.canHandle(input)).rejects.toThrow(UnsupportedMediaTypeHttpError);
    input.request.headers = { 'content-type': 'text/plain' };
    await expect(bodyParser.canHandle(input)).rejects.toThrow(UnsupportedMediaTypeHttpError);
    input.request.headers = { 'content-type': 'application/sparql-update' };
    await expect(bodyParser.canHandle(input)).resolves.toBeUndefined();
  });

  it('errors when handling invalid SPARQL updates.', async(): Promise<void> => {
    input.request = streamifyArray([ 'VERY INVALID UPDATE' ]) as HttpRequest;
    await expect(bodyParser.handle(input)).rejects.toThrow(BadRequestHttpError);
  });

  it('errors when receiving an unexpected error.', async(): Promise<void> => {
    const mock = jest.spyOn(algebra, 'translate').mockImplementationOnce((): any => {
      throw 'apple';
    });
    input.request = streamifyArray(
      [ 'DELETE DATA { <http://test.com/s> <http://test.com/p> <http://test.com/o> }' ],
    ) as HttpRequest;
    await expect(bodyParser.handle(input)).rejects.toThrow(BadRequestHttpError);
    mock.mockRestore();
  });

  it('converts SPARQL updates to algebra.', async(): Promise<void> => {
    input.request = streamifyArray(
      [ 'DELETE DATA { <http://test.com/s> <http://test.com/p> <http://test.com/o> }' ],
    ) as HttpRequest;
    const result = await bodyParser.handle(input);
    expect(result.algebra.type).toBe(Algebra.types.DELETE_INSERT);
    expect((result.algebra as Algebra.DeleteInsert).delete).toBeRdfIsomorphic([ quad(
      namedNode('http://test.com/s'),
      namedNode('http://test.com/p'),
      namedNode('http://test.com/o'),
    ) ]);
    expect(result.binary).toBe(true);
    expect(result.metadata).toBe(input.metadata);

    expect(await arrayifyStream(result.data)).toEqual(
      [ 'DELETE DATA { <http://test.com/s> <http://test.com/p> <http://test.com/o> }' ],
    );
  });
});
