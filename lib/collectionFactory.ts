import { ObjectID, AggregationCursor, Cursor, FindOneOptions, FindOneAndReplaceOption, MongoCountPreferences } from 'mongodb'
import { map as bluebirdMap } from 'bluebird'
import { each as _each, map as _map} from 'lodash'

import { getDbInstance } from './database'
import { ICollectionProvider, IFilter, IDocument, Func, IPaginationResult, IQueryParameters } from './interfaces'

export abstract class CollectionFactory<TDocument extends IDocument> {
  constructor(public collectionName: string, private documentType: any, public searchableProperties: string[] = []) {
  }

  sanitizeId(filter: IFilter) {
    var hasId = filter.hasOwnProperty('_id')
    if(hasId && typeof filter['_id'] !== 'object') {
      filter['_id'] = new ObjectID(filter['_id'])
    }
  }

  get collection(): ICollectionProvider<TDocument> {
    return () => getDbInstance().collection<TDocument>(this.collectionName)
  }

  aggregate(pipeline: Object[]): AggregationCursor<TDocument> {
    return this.collection().aggregate(pipeline)
  }

  protected get undefinedObject(): TDocument{ //TODO: how to detect this as undefined?
    return <TDocument>new this.documentType()
  }

  async findOne(filter: IFilter, options?: FindOneOptions ): Promise<TDocument> {
    this.sanitizeId(filter)
    let document = await this.collection().findOne(filter, options)
    if(document) {
      return <TDocument>new this.documentType(document)
    }
    return this.undefinedObject
  }

  async findOneAndUpdate(filter: IFilter, update: Object, options?: FindOneAndReplaceOption ): Promise<TDocument> {
    this.sanitizeId(filter)
    let document = await this.collection().findOneAndUpdate(filter, update, options)
    return this.hydrateObject(document.value) || this.undefinedObject
  }

  async findWithPagination(queryParams: Object, aggregationCursor?: Func<AggregationCursor<TDocument>>,
    query?: string | Object, searchableProperties?: string[], hydrate = false): Promise<IPaginationResult<any>> {

    let collection = this

    let options = this.buildQueryParameters(queryParams)

    let pagingCursor: AggregationCursor<TDocument>
    let totalCursor: AggregationCursor<TDocument> | undefined
    let cursor: Cursor<TDocument> | AggregationCursor<TDocument>

    if(aggregationCursor) {
      pagingCursor = aggregationCursor()
      totalCursor = aggregationCursor()

      if(options && options.filter) {
        pagingCursor = pagingCursor.match(this.buildTokenizedQueryObject(options.filter, this.searchableProperties))
      }

      cursor = pagingCursor
    } else {
      if(!query) {
        query = {}
      }
      cursor = this.getCursor(query, searchableProperties || this.searchableProperties)
    }

    let documents = this.buildQuery(cursor, options).toArray()

    return {
        data: await bluebirdMap(documents, function(document: TDocument) {
          return hydrate ? collection.hydrateObject(document) : document
      }),
      total: await this.getTotal(totalCursor, query)
    }
  }

  async getTotal(aggregationCursor?: AggregationCursor<TDocument>, query = {}): Promise<number> {
    if(aggregationCursor) {
      let result = await aggregationCursor.group({_id: null, count: { $sum: 1 } }).toArray()
      return result.length > 0 ? (result[0] as any).count : 0
    } else {
      return this.count(query)
    }
  }

  getCursor(query: string | Object, searchableProperties: string[]): Cursor<TDocument> {
    let builtQuery = {}
    if(typeof query === 'string') {
      builtQuery = this.buildTokenizedQueryObject(query, searchableProperties)
    } else {
      builtQuery = query
    }
    return this.collection().find(builtQuery)
  }

  fieldsArrayToObject(fields: string[]): Object {
    let fieldsObject: IFilter = {}

    _each(fields, function(field) {
      fieldsObject[field] = 1
    })

    return fieldsObject
  }

  async find(query: Object, fields?: Object, skip?: number, limit?: number, timeout?: number ): Promise<TDocument[]> {
    let collection = this
    let documents = this.collection().find(query, fields, skip, limit, timeout).toArray()
    return bluebirdMap(documents, function(document) {
      return collection.hydrateObject(document) || collection.undefinedObject
    })
  }

  hydrateObject(document: TDocument | undefined): TDocument | undefined {
    if(document) {
        return <TDocument>new this.documentType(document)
    }
    return undefined
  }

  async count(query: Object, options?: MongoCountPreferences): Promise<number> {
    return await this.collection().count(query, options)
  }

  private tokenize(searchText: string): RegExp {
    var splitValues = searchText.split(' ').filter((val) => typeof val === 'string')

    if(!splitValues){
        return /.*/;
    }

    var regexpString = '^(?=.*' + splitValues.join(')(?=.*') + ').*$';
    return new RegExp(regexpString, 'i');
  }

  buildTokenizedQueryObject(filter: string, searchableProperties: string[]): Object {
    let that = this
    let query = _map(searchableProperties, function(property: string) {
        let obj: any = {}
        obj[property] = that.tokenize(filter);
        return obj;
    });

    return { $or: query };
  }

  buildQueryParameters(query?: any): IQueryParameters | undefined {
    if(!query) {
      return undefined
    }
    let toReturn: IQueryParameters = {}

    if(query.filter && query.filter.length > 0) {
      toReturn.filter = query.filter
    }

    if(query.skip) {
      toReturn.skip = parseInt(query.skip)
    }

    if(query.limit) {
      toReturn.limit = parseInt(query.limit)
    }

    if(query.order) {
      toReturn.sortKeyOrList = query.order
    }

    return toReturn
  }

  sortKeyToObject(sortKey: string | Object): Object {
    if(typeof sortKey !== 'string') {
      return sortKey
    }
    else {
      let sortObject: {[index:string]: number} = {}
      let isDesc = sortKey[0] === '-'
      sortObject[sortKey.substring(isDesc ? 1 : 0)] = isDesc ? -1 : 1
      return sortObject
    }
  }

  sortKeyOrListToObject(sortKeyOrList: string | Object[] | Object): Object[] {
    if(typeof sortKeyOrList === 'string') {
      return [this.sortKeyToObject(sortKeyOrList)]
    } else if(!Array.isArray(sortKeyOrList)) {
      return [sortKeyOrList]
    } else {
      return _map(sortKeyOrList, (key) => this.sortKeyToObject(key))
    }
  }

  buildQuery(cursor: Cursor<TDocument> | AggregationCursor<TDocument>, parameters?: IQueryParameters)
    : Cursor<TDocument> | AggregationCursor<TDocument> {
    if(parameters) {
      if(parameters.sortKeyOrList) {
        for(let sortObject of this.sortKeyOrListToObject(parameters.sortKeyOrList)) {
          cursor = (cursor as AggregationCursor<TDocument>).sort(sortObject)
        }
      }

      if(parameters.skip) {
        cursor = cursor.skip(parameters.skip)
      }

      if(parameters.limit) {
        cursor = cursor.limit(parameters.limit)
      }
    }

    return cursor
  }
}