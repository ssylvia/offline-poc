import { useCallback, useEffect, useState } from 'react'
import { getErrorMessage } from '../format.ts'
import {
  chooseDirectory,
  clearSelectedDirectory,
  getSelectedDirectory,
  isDirectoryStorageSupported,
  reconnectDirectory,
  type DirectoryDestination,
} from './directory.ts'

export interface DirectoryDestinationState {
  choose: () => Promise<void>
  clear: () => Promise<void>
  destination?: DirectoryDestination
  error: string
  isBusy: boolean
  isSupported: boolean
  reconnect: () => Promise<void>
  revision: number
}

export function useDirectoryDestination(): DirectoryDestinationState {
  const [destination, setDestination] = useState<DirectoryDestination>()
  const [error, setError] = useState('')
  const [isBusy, setIsBusy] = useState(true)
  const [revision, setRevision] = useState(0)
  const isSupported = isDirectoryStorageSupported()

  useEffect(() => {
    let cancelled = false
    void getSelectedDirectory()
      .then((selected) => {
        if (!cancelled) {
          setDestination(selected)
        }
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(`The saved folder setting could not be read: ${getErrorMessage(loadError)}`)
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsBusy(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  const choose = useCallback(async () => {
    setIsBusy(true)
    setError('')
    try {
      setDestination(await chooseDirectory())
      setRevision((current) => current + 1)
    } catch (chooseError) {
      if (chooseError instanceof DOMException && chooseError.name === 'AbortError') {
        return
      }
      setError(`The folder could not be selected: ${getErrorMessage(chooseError)}`)
    } finally {
      setIsBusy(false)
    }
  }, [])

  const reconnect = useCallback(async () => {
    if (!destination) {
      setError('Choose a folder before reconnecting it.')
      return
    }
    setIsBusy(true)
    setError('')
    try {
      setDestination(await reconnectDirectory(destination.id))
      setRevision((current) => current + 1)
    } catch (reconnectError) {
      setError(`The folder could not be reconnected: ${getErrorMessage(reconnectError)}`)
    } finally {
      setIsBusy(false)
    }
  }, [destination])

  const clear = useCallback(async () => {
    setIsBusy(true)
    setError('')
    try {
      await clearSelectedDirectory()
      setDestination(undefined)
      setRevision((current) => current + 1)
    } catch (clearError) {
      setError(`The storage destination could not be changed: ${getErrorMessage(clearError)}`)
    } finally {
      setIsBusy(false)
    }
  }, [])

  return {
    choose,
    clear,
    destination,
    error,
    isBusy,
    isSupported,
    reconnect,
    revision,
  }
}
